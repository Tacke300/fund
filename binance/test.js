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
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try { errorDetails = { ...errorDetails, ...JSON.parse(data) }; }
                    catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; }
                    addLog(`HTTP Err: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => {
            addLog(`Net Err: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });
        if (postData) req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Err: API/SECRET key missing.");

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
        throw new Error(`Method unsupported: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`API Err (${method} ${fullEndpointPath}): ${error.code || 'UNK'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Too many API errors, bot stopping.");
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
        addLog(`Public API Err: ${error.msg || error.message}`);
        throw error;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`Sync time. Diff: ${serverTimeOffset} ms.`); } catch (e) { addLog(`Time sync Err: ${e.message}`); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const bracket = r.find(i => i.symbol === symbol)?.brackets[0]; return bracket ? parseInt(bracket.initialLeverage) : null; } catch (e) { addLog(`Get leverage Err: ${e.msg}`); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`Set leverage Err: ${e.msg}`); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); addLog('Loaded exchange info.'); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Get price Err: ${e.message}`); return null; } }

async function cancelOpenOrdersForSymbol(symbol, positionSide = null) {
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            addLog("No open orders to cancel.");
            return;
        }

        let ordersToCancel = openOrders;
        if (positionSide) {
            ordersToCancel = openOrders.filter(o => o.positionSide === positionSide);
        }

        if (ordersToCancel.length === 0) {
            addLog(`No open orders matching side: ${positionSide}.`);
            return;
        }

        addLog(`Canceling ${ordersToCancel.length} orders for ${symbol} (${positionSide || 'All'})...`);
        for (const order of ordersToCancel) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId });
            } catch (innerError) {
                 if (innerError.code !== -2011) addLog(`Err canceling order ${order.orderId}: ${innerError.msg || innerError.message}`);
            }
            await sleep(50);
        }
        addLog("Cancel open orders finished.");

    } catch (error) {
        if (error.code !== -2011) addLog(`Err getting open orders: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function cleanupAndResetCycle(symbol) {
    addLog(`Trade cycle for ${symbol} finished. Cleaning up...`);

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

    addLog(`[Trade] ID ${orderId} (${positionSide} ${side}) Qty ${parseFloat(quantity).toFixed(4)} PNL ${realizedPnl.toFixed(4)}`);

    if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
    netPNL = totalProfit - totalLoss;
    addLog(`Net PNL: ${netPNL.toFixed(2)} (P: ${totalProfit.toFixed(2)}, L: ${totalLoss.toFixed(2)})`);

    const isLongClosureByBotTarget = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosureByBotTarget = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    if (isLongClosureByBotTarget || isShortClosureByBotTarget) {
        addLog(`Main bot order ${orderId} (${positionSide}) filled.`);

        const closedPositionSide = positionSide;
        const remainingPosition = (closedPositionSide === 'LONG') ? currentShortPosition : currentLongPosition;

        if (closedPositionSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;

        if (realizedPnl >= 0) {
             addLog(`WIN position (${closedPositionSide}) closed. Checking LOSING position.`);
             if (remainingPosition) {
                 const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol });
                 const currentLosingQtyOnExchange = Math.abs(parseFloat(positionsOnExchange.find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side)?.positionAmt || 0));
                 if (currentLosingQtyOnExchange > 0) {
                      addLog(`LOSING position ${remainingPosition.side} found (${currentLosingQtyOnExchange}). Closing completely.`);
                      await closePosition(remainingPosition.symbol, 0, `Opposite WIN leg closed`, remainingPosition.side);
                 } else {
                      addLog(`LOSING position ${remainingPosition.side} not found on exchange.`);
                 }
             } else {
                  addLog(`No remaining LOSING position found.`);
             }
             await cleanupAndResetCycle(symbol);

        } else {
             addLog(`LOSS position (${closedPositionSide}) closed. Remaining leg will run.`);
        }
    } else {
         addLog(`Order ${orderId} not main bot TP/SL. Partial close or manual.`);
    }
    isProcessingTrade = false;
}


async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;
    isProcessingTrade = true;

    addLog(`Closing ${positionSide} ${symbol} (Reason: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            await cancelOpenOrdersForSymbol(symbol, positionSide);
            await sleep(500);

            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            if (qtyToClose === 0) {
                 addLog(`${positionSide} position already closed on exchange.`);
                 return false;
            }
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            addLog(`Sending MARKET close order for ${positionSide} Qty: ${qtyToClose}`);
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`Sent ${positionSide} close order.`);
            return true;
        } else {
            addLog(`${positionSide} position already closed or non-existent.`);
            return false;
        }
    } catch (error) {
        addLog(`Err closing ${positionSide}: ${error.msg || error.message}`);
        return false;
    } finally {
        isProcessingTrade = false;
    }
}

async function openMarketPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    addLog(`Opening ${tradeDirection} ${symbol} with ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Err getting symbol details.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Err setting leverage.");

        await sleep(200);

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) throw new Error("Err getting current price.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / currentPrice;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (quantity * currentPrice < symbolDetails.minNotional) {
             addLog(`Order value too small: ${quantity * currentPrice}. Min: ${symbolDetails.minNotional}`);
             throw new Error("Order value too small.");
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        addLog(`Sending MARKET ${tradeDirection} order Qty: ${quantity.toFixed(symbolDetails.quantityPrecision)} at price approx ${currentPrice.toFixed(symbolDetails.pricePrecision)}`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity,
        });

        let openPos = null;
        const maxRetries = 10;
        const retryDelay = 500;

        for(let i = 0; i < maxRetries; i++) {
            await sleep(retryDelay);
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) >= quantity * 0.95); // Check if qty is close to ordered
            if (openPos && Math.abs(parseFloat(openPos.positionAmt)) > 0) {
                 addLog(`Position confirmed on exchange after ${i+1} tries.`);
                 break;
            }
             if(i < maxRetries - 1) addLog(`Position not found on exchange yet. Retrying check... (${i+1}/${maxRetries})`);
        }


        if (!openPos || Math.abs(parseFloat(openPos.positionAmt)) === 0) throw new Error("Position not confirmed on exchange after retries.");

        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Opened ${tradeDirection} | Qty: ${actualQuantity.toFixed(symbolDetails.quantityPrecision)} | Entry: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

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
        addLog(`Err opening ${tradeDirection}: ${error.msg || error.message}`);
        return null;
    }
}

async function setInitialTPAndSL(position) {
    if (!position) return false;
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity } = position;
    addLog(`Setting initial TP/SL for ${side}...`);
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

        addLog(`Initial TP/SL for ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)}`);

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
        addLog(`Crit Err setting initial TP/SL for ${side}: ${error.msg || error.message}.`);
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
                addLog(`Canceled old ${type} order ${orderIdToCancel} for ${side}.`);
            } catch (innerError) {
                if (innerError.code !== -2011) addLog(`Err canceling old ${type} order ${orderIdToCancel}: ${innerError.msg || innerError.message}`);
            }
        }

        const symbolDetails = await getSymbolDetails(symbol);
        const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        const currentPositionOnExchange = positionsOnExchange.find(p => p.symbol === symbol && p.positionSide === side);
        const actualQuantity = Math.abs(parseFloat(currentPositionOnExchange?.positionAmt || 0));

        if (actualQuantity === 0) {
             addLog(`${side} pos closed, cannot set new ${type} order.`);
             if (type === 'STOP') position.currentSLId = null;
             return null;
        }

        const quantityToUse = parseFloat((Math.floor(actualQuantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToUse <= 0) {
            addLog(`Qty for new ${type} order too small (${quantityToUse}).`);
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
        addLog(`Set new ${type} order for ${side} at ${stopPriceFormatted}. ID: ${newOrder.orderId}`);

        if (type === 'STOP') position.currentSLId = newOrder.orderId;

        return newOrder.orderId;
    } catch (error) {
        addLog(`Err updating ${type} order for ${side}: ${error.msg || error.message}`);
        if (type === 'STOP') position.currentSLId = null;
        return null;
    }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || isProcessingTrade) return false;
    isProcessingTrade = true;

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Err getting symbol details for partial close.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        if (currentQty === 0) {
            addLog(`${position.side} pos closed on exchange, no partial close needed.`);
            position.closedLossAmount = position.initialQuantity;
            position.hasClosedAllLossPositionAtLastLevel = true;
            return false;
        }

        quantityToClose = Math.min(quantityToClose, currentQty);

        quantityToClose = parseFloat((Math.floor(quantityToClose / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantityToClose <= 0) {
            addLog(`Partial close qty too small or invalid: ${quantityToClose}.`);
            return false;
        }

        const orderSide = (position.side === 'LONG') ? 'SELL' : 'BUY';

        addLog(`Partial close ${quantityToClose.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} of ${position.side} loss position.`);

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
        addLog(`Sent partial close order. Total closed Qty: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);

        return true;
    } catch (error) {
        addLog(`Err partial closing ${position.side}: ${error.msg || error.message}`);
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
        if (!symbolDetails) throw new Error("Err getting symbol details for add pos.");

        const currentPositionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = currentPositionsOnExchange.find(p => p.symbol === position.symbol && p.positionSide === position.side);
        const currentQty = Math.abs(parseFloat(posOnBinance?.positionAmt || 0));

        let effectiveQuantityToAdd = quantityToAdd;
        const maxQtyAllowedToAdd = position.initialQuantity - currentQty;
        effectiveQuantityToAdd = Math.min(effectiveQuantityToAdd, maxQtyAllowedToAdd);

        if (effectiveQuantityToAdd <= 0) {
            addLog(`Add pos qty too small (${effectiveQuantityToAdd}) or current Qty >= initial Qty.`);
            return false;
        }

        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

         if (effectiveQuantityToAdd <= 0) {
             addLog(`Add pos qty after rounding too small (${effectiveQuantityToAdd}).`);
             return false;
         }

        const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL';

        addLog(`Adding ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)} ${position.symbol} to ${position.side} pos (re-opening).`);

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

        addLog(`Sent add pos order. Qty to add: ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)}. Awaiting fill.`);

        position.closedLossAmount -= effectiveQuantityToAdd;
        if (position.closedLossAmount < 0) position.closedLossAmount = 0;
        addLog(`Total closed loss Qty remaining: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);

        const winningPos = (position.side === 'LONG' && currentShortPosition) ? currentShortPosition :
                           (position.side === 'SHORT' && currentLongPosition) ? currentLongPosition : null;

        if (winningPos) {
             addLog("Re-opened loss pos. Resetting state & initial TP/SL for pair...");
             winningPos.nextPartialCloseLossIndex = 0;
             winningPos.hasAdjustedSLToSpecificLevel = {};
             position.hasClosedAllLossPositionAtLastLevel = false;

             await sleep(1000);
             await setInitialTPAndSL(winningPos);
             await sleep(500);
             await setInitialTPAndSL(position);
             addLog("State reset & initial TP/SL re-set.");
        } else {
             addLog("Re-opened loss pos, but cannot find opposite leg to reset pair state.");
        }

        return true;
    } catch (error) {
        addLog(`Err adding to ${position.side} pos: ${error.msg || error.message}`);
        return false;
    } finally {
        isProcessingTrade = false;
    }
}


async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;

    addLog('Starting new cycle...');
    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);

        const requiredAmount = INITIAL_INVESTMENT_AMOUNT;
        if (usdtAsset < requiredAmount) {
            addLog(`Insufficient USDT (${usdtAsset.toFixed(2)}), need ${requiredAmount.toFixed(2)}. Wait for next cycle.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog("Cannot get leverage. Skipping cycle.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const initialPairPrice = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (!initialPairPrice) {
            addLog("Cannot get initial price. Skipping cycle.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const longPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!longPositionData) {
            addLog("Failed to open LONG. Skipping cycle.");
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentLongPosition = longPositionData;
        currentLongPosition.pairEntryPrice = initialPairPrice;

        await sleep(500);

        const shortPositionData = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!shortPositionData) {
            addLog('Failed to open SHORT. Closing LONG.');
            await closePosition(currentLongPosition.symbol, 0, 'Failed to open SHORT', 'LONG');
            currentLongPosition = null;
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        currentShortPosition = shortPositionData;
        currentShortPosition.pairEntryPrice = initialPairPrice;


        addLog("Both positions opened. Waiting 3s to set TP/SL...");
        await sleep(3000);

        const isLongTPSLSet = await setInitialTPAndSL(currentLongPosition);
        if (!isLongTPSLSet) {
             addLog("Failed to set TP/SL for LONG. Closing both.");
             await closePosition(currentLongPosition.symbol, 0, 'Failed to set TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Failed to set TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        await sleep(500);

        const isShortTPSLSet = await setInitialTPAndSL(currentShortPosition);
         if (!isShortTPSLSet) {
             addLog("Failed to set TP/SL for SHORT. Closing both.");
             await closePosition(currentLongPosition.symbol, 0, 'Failed to set TP/SL', 'LONG');
             await closePosition(currentShortPosition.symbol, 0, 'Failed to set TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        addLog("TP/SL set for both. Starting monitoring.");
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 15000);
        }
    } catch (error) {
        addLog(`Err in main cycle: ${error.msg || error.message}`);
        if(botRunning) scheduleNextMainCycle();
    }
}

const manageOpenPosition = async () => {
    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        addLog("No open pos to monitor.");
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
                 addLog(`LONG pos not on exchange. Updating bot state.`);
                 currentLongPosition = null;
             }
        }
         if (currentShortPosition) {
             if(shortPosOnExchange){
                currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
                currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
            } else {
                 addLog(`SHORT pos not on exchange. Updating bot state.`);
                 currentShortPosition = null;
             }
         }

        if (!currentLongPosition && !currentShortPosition) {
            addLog("Both positions closed.");
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
                        addLog(`${winningPos.side} reached ${nextCloseLevel}% profit. Closing 20% of ${losingPos.side} loss pos initial Qty.`);
                    } else if (winningPos.nextPartialCloseLossIndex === PARTIAL_CLOSE_INDEX_8) {
                         quantityToCloseFraction = 1.00;
                         addLog(`${winningPos.side} reached ${nextCloseLevel}% profit. Closing 100% of remaining ${losingPos.side} loss pos.`);
                    } else if (winningPos.nextPartialCloseLossIndex < winningPos.partialCloseLossLevels.length) {
                        quantityToCloseFraction = 0.10;
                         addLog(`${winningPos.side} reached ${nextCloseLevel}% profit. Closing 10% of ${losingPos.side} loss pos initial Qty.`);
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
                            if (remainingQtyAfterClose <= 0 || winningPos.nextPartialCloseLossIndex > winningPos.partialCloseLossLevels.length -1 ) { // Check if index exceeds last defined level
                                losingPos.hasClosedAllLossPositionAtLastLevel = true;
                                addLog(`${losingPos.side} loss pos completely closed.`);
                            }
                        }
                    } else {
                        addLog(`${losingPos.side} loss pos already closed on exchange, no partial close needed.`);
                         losingPos.hasClosedAllLossPositionAtLastLevel = true;
                        winningPos.nextPartialCloseLossIndex++;
                    }
                } else {
                     winningPos.nextPartialCloseLossIndex++;
                }
            }

            if (PARTIAL_CLOSE_LEVEL_5 !== undefined && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_5 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5]) {
                addLog(`${winningPos.side} reached ${PARTIAL_CLOSE_LEVEL_5}% profit. Adjusting ${losingPos.side} SL.`);

                 const currentLosingQtyOnExchange = Math.abs(parseFloat((await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: losingPos.symbol })).find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || 0));

                if (losingPos && currentLosingQtyOnExchange > 0 && PARTIAL_CLOSE_LEVEL_8 !== undefined) {
                    const lossPercentageAtLevel8 = PARTIAL_CLOSE_LEVEL_8 / 100;
                    const priceChangeForLosingSL = (losingPos.initialMargin * (lossPercentageAtLevel8 / 100)) / losingPos.initialQuantity;
                    const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeForLosingSL : losingPos.entryPrice + priceChangeForLosingSL).toFixed(losingPos.pricePrecision));

                    losingPos.currentSLId = await updateStopLimitOrder(losingPos, slPriceLosing, 'STOP');
                    if (losingPos.currentSLId) {
                        addLog(`LOSING SL ${losingPos.side} moved to ${slPriceLosing.toFixed(losingPos.pricePrecision)} (PNL ${PARTIAL_CLOSE_LEVEL_8}%).`);
                        winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true;
                    } else {
                        addLog(`Cannot set LOSING SL for ${losingPos.side} at WIN ${PARTIAL_CLOSE_LEVEL_5}% profit level.`);
                    }
                } else {
                    addLog(`Cannot adjust LOSING SL for ${losingPos.side} at WIN ${PARTIAL_CLOSE_LEVEL_5}% profit level because position is closed or non-existent.`);
                    winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5] = true;
                }
            }

             if (PARTIAL_CLOSE_LEVEL_8 !== undefined && currentProfitPercentage >= PARTIAL_CLOSE_LEVEL_8 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_8]) {
                 addLog(`${winningPos.side} reached ${PARTIAL_CLOSE_LEVEL_8}% profit.`);
                 if (losingPos.hasClosedAllLossPositionAtLastLevel) {
                     addLog(`LOSING pos ${losingPos.side} already completely closed.`);
                 } else {
                     addLog(`LOSING pos ${losingPos.side} not completely closed at WIN ${PARTIAL_CLOSE_LEVEL_8}% profit. Attempting to close remaining.`);
                     await closePosition(losingPos.symbol, 0, `Close remaining at WIN ${PARTIAL_CLOSE_LEVEL_8}%`, losingPos.side);
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
                    addLog(`Price ${currentMarketPrice?.toFixed(winningPos.pricePrecision) || 'N/A'} near pair entry ${pairEntryPrice?.toFixed(winningPos.pricePrecision) || 'N/A'}. Re-opening ${losingPos.side} loss pos.`);
                    await addPosition(losingPos, losingPos.closedLossAmount);
                }
            }
        }

    } catch (error) {
        addLog(`Err monitoring pos: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
};

async function scheduleNextMainCycle() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;
    clearTimeout(nextScheduledCycleTimeout);
    addLog(`Scheduling next cycle in 2s...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

async function getListenKey() { if (!API_KEY || !SECRET_KEY) { addLog("API Key not configured."); return null; } try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog(`Got new listenKey.`); return data.listenKey; } catch (e) { addLog(`Err getting listenKey: ${e.message}`); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Err refreshing listenKey. Getting new...`); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); } } }

function setupMarketDataStream(symbol) {
    if (marketWs) marketWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice`;
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => addLog(`Market WS for ${symbol} connected.`);
    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'markPriceUpdate' && data.s === symbol) {
                currentMarketPrice = parseFloat(data.p);
            }
        } catch (e) {}
    };
    marketWs.onclose = () => {
        addLog(`Market WS for ${symbol} closed. Reconnecting in 5s...`);
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
    marketWs.onerror = (error) => {
        addLog(`Err Market WS for ${symbol}: ${error.message}`);
         if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
}

function setupUserDataStream(key) {
    if (userDataWs) userDataWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${key}`;
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('User Data WS connected.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000);
    };
    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(data.o);
            }
        } catch (e) {}
    };
    userDataWs.onclose = async () => {
        addLog('User Data WS closed. Reconnecting in 5s...');
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("Cannot get new listenKey for User Data WS reconnect.");
            }, 5000);
        }
    };
    userDataWs.onerror = (error) => {
        addLog(`Err User Data WS: ${error.message}`);
        if (botRunning) {
            setTimeout(async () => {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
                 else addLog("Cannot get new listenKey for User Data WS reconnect after error.");
            }, 5000);
        }
    };
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot is already running.';
    if (!API_KEY || !SECRET_KEY) return 'Err: API/SECRET key missing.';

    addLog('--- Starting Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();

        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
         else throw new Error("Cannot setup User Data Stream.");

        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot started at ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Initial Amt: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        scheduleNextMainCycle();
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 15000);
        }
        return 'Bot started successfully.';
    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Bot Start Err] ${errorMsg}`);
        stopBotLogicInternal();
        return `Bot start Err: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot not running.';
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
    addLog('--- Bot stopped ---');
    return 'Bot stopped.';
}

async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Checking for remaining positions for ${symbol}.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Found ${remainingPositions.length} remaining pos. Closing...`);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const success = await closePosition(pos.symbol, 0, `Remaining pos on start/reset`, sideToClose);
                if(success) await sleep(1000);
            }
        } else {
            addLog(`No remaining pos for ${symbol}.`);
        }
    } catch (error) {
        addLog(`Err checking remaining pos: ${error.msg || error.message}`);
    }
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).send('Err reading log file');
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
        let statusMessage = 'SERVER: OFF (PM2)';
        if (botProcess) {
            statusMessage = `SERVER: ${botProcess.pm2_env.status.toUpperCase()}`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | BOT: ${botRunning ? 'RUNNING' : 'STOPPED'}`;
                if (botStartTime) {
                    const uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / 60000);
                    statusMessage += ` | Uptime: ${uptimeMinutes} min`;
                }
                statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL} | Amt: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                 let openPositionsText = " | Pos: NONE";
                 if(currentLongPosition || currentShortPosition) {
                    openPositionsText = " | Pos: ";
                    if(currentLongPosition) openPositionsText += `LONG (${currentLongPosition.unrealizedPnl?.toFixed(2) || 'N/A'} PNL) `;
                    if(currentShortPosition) openPositionsText += `SHORT (${currentShortPosition.unrealizedPnl?.toFixed(2) || 'N/A'} PNL)`;
                 }
                 statusMessage += openPositionsText;
            }
        }
        res.send(statusMessage);
    } catch (error) {
        res.status(500).send(`Err getting PM2 status.`);
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

        addLog(`Config updated: Coin: ${TARGET_COIN_SYMBOL}, Amt: ${INITIAL_INVESTMENT_AMOUNT} USDT`);

        if (oldSymbol !== TARGET_COIN_SYMBOL) {
            addLog(`Coin changed ${oldSymbol} -> ${TARGET_COIN_SYMBOL}. Resetting state.`);
            stopBotLogicInternal();
            setTimeout(() => startBotLogicInternal(), 2000);
        }
        res.json({ success: true, message: 'Config updated.' });
    } else {
        res.status(400).send('Invalid config data.');
    }
});

app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));

app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server on port ${WEB_SERVER_PORT}`);
    addLog(`Manage at: http://localhost:${WEB_SERVER_PORT}`);
});
