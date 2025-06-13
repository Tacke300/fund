
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

let isClosingPosition = false;

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

const WEB_SERVER_PORT = 1111;
const THIS_BOT_PM2_NAME = process.env.PM2_NAME || 'test';
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${THIS_BOT_PM2_NAME}-out.log`;

const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;

function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    if (!isImportant) {
        const messageHash = crypto.createHash('md5').update(message).digest('hex');
        if (logCounts[messageHash]) {
            if ((now.getTime() - logCounts[messageHash].lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
                logCounts[messageHash].count++;
                logCounts[messageHash].lastLoggedTime = now; // Update time even if not logging to reset cooldown
                return; // Skip logging if within cooldown and not first time
            }
             logCounts[messageHash] = { count: 1, lastLoggedTime: now }; // Reset counter
        } else {
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    }


    console.log(logEntry);
    if (LOG_TO_CUSTOM_FILE) {
        fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {
            if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
        });
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
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
                    let errorDetails = { code: res.statusCode, msg: `HTTP Error: ${res.statusCode} ${res.statusMessage}` };
                    try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; } catch (e) {}
                    // Add minimal log for API errors in callSignedAPI or callPublicAPI
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: e.message }));
        if (method === 'POST' || method === 'PUT') req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new CriticalApiError("Missing API_KEY or SECRET_KEY. Check config.js.");
    }
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;

    let queryString = Object.keys(params)
                                    .map(key => `${key}=${params[key]}`)
                                    .join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath, requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST' || method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Method not supported: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        let errorMsg = `API error (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`;
        addLog(errorMsg, true);

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Critical API error, bot stopping.");
        }
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');
    const headers = { 'Content-Type': 'application/json' };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        let errorMsg = `Public API error (GET ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`;
        addLog(errorMsg, true);

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Critical API error, bot stopping.");
        }
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
        addLog(`Time sync: offset ${serverTimeOffset} ms.`);
    } catch (error) {
        addLog(`Failed to sync time: ${error.message}.`, true);
        serverTimeOffset = 0;
        throw error;
    }
}

async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);
            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                return parseInt(symbolData.brackets[0].maxInitialLeverage || symbolData.brackets[0].initialLeverage);
            }
        }
        addLog(`Valid leverage not found for ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`Error getting leverage for ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

async function setLeverage(symbol, leverage) {
    try {
        addLog(`Setting ${leverage}x leverage for ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });
        addLog(`Set ${leverage}x leverage for ${symbol} success.`);
        return true;
    } catch (error) {
        addLog(`Failed to set ${leverage}x leverage for ${symbol}: ${error.msg || error.message}`, true);
        if (error.code === -4046 || error.code === -4048) {
             addLog(`Leverage ${leverage}x is not valid for ${symbol}.`);
        }
        return false;
    }
}

async function getExchangeInfo() {
    if (exchangeInfoCache) return exchangeInfoCache;

    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0.001),
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
            };
        });
        addLog('Exchange info loaded.');
        return exchangeInfoCache;
    } catch (error) {
        addLog('Error loading exchange info: ' + (error.msg || error.message), true);
        exchangeInfoCache = null;
        throw error;
    }
}

async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    return filters ? filters[symbol] : null;
}

async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(data.price);
    } catch (error) {
        // Logged in callPublicAPI
        return null;
    }
}

async function cancelOpenOrdersForSymbol(symbol, orderId = null, positionSide = null) {
    try {
        let params = { symbol };
        if (orderId) params.orderId = orderId;
        if (positionSide && positionSide !== 'BOTH') params.positionSide = positionSide;

        if (orderId) {
            addLog(`Canceling order ${orderId} for ${symbol} (PositionSide: ${positionSide || 'Any'}).`);
            await callSignedAPI('/fapi/v1/order', 'DELETE', params);
            addLog(`Order ${orderId} for ${symbol} canceled.`);
        } else {
            addLog(`Canceling all open orders for ${symbol} (PositionSide: ${positionSide || 'Any'}).`);
            await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', params);
            addLog(`All open orders for ${symbol} canceled.`);
        }
    } catch (error) {
        if (error.code === -2011) { // Unknown order / No orders to cancel
             // AddLog here if you want to explicitly see when nothing was found to cancel
             // addLog(`No open orders to cancel for ${symbol} (OrderId: ${orderId || 'ALL'}, positionSide: ${positionSide || 'ANY'}).`);
        } else {
            addLog(`Error canceling order(s) for ${symbol}: ${error.msg || error.message}`, true);
             if (error instanceof CriticalApiError) throw error; // Re-throw critical errors
        }
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnl, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') {
        return;
    }

    // Update total PNL for any filled order with PNL (including partials from addPosition/closePartialPosition logic if PNL != 0)
    if (parseFloat(realizedPnl) !== 0) {
        if (parseFloat(realizedPnl) > 0) {
            totalProfit += parseFloat(realizedPnl);
        } else {
            totalLoss += Math.abs(parseFloat(realizedPnl));
        }
        netPNL = totalProfit - totalLoss;

        addLog(`Trade Closed: ${positionSide} ${symbol} | PNL: ${parseFloat(realizedPnl).toFixed(2)} USDT | Total PNL: ${netPNL.toFixed(2)} (P: ${totalProfit.toFixed(2)}, L: ${totalLoss.toFixed(2)})`, true);
    } else {
        // Log filled orders with 0 PNL if they are significant (like open or market closes)
         // if (!['MARKET', 'LIMIT', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(orderInfo.o)) { // Only log types that aren't TP/SL
         //    addLog(`Filled order ${orderId} (${orderInfo.o}) for ${symbol} (PS:${positionSide}) PNL=0. Qty: ${orderInfo.q}`);
         // }
         return; // Do not proceed if PNL is 0 for trade result
    }


    let isBotMainClosure = false;
     // Check if this is a filled TP/SL order corresponding to our currently tracked positions
    if (currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId)) {
         addLog(`Detected filled main TP/SL (${orderId}) for LONG leg.`, true);
         isBotMainClosure = true;
     } else if (currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId)) {
         addLog(`Detected filled main TP/SL (${orderId}) for SHORT leg.`, true);
         isBotMainClosure = true;
     }


    // If this is a main TP/SL filling, close the other position and reset cycle
    if (isBotMainClosure) {
        addLog(`Main TP/SL triggered for ${positionSide}. Attempting to close the other position and reset cycle.`, true);

        let otherPosition = null;
        let positionToCloseSide = null;

        if (positionSide === 'LONG' && currentShortPosition) {
            otherPosition = currentShortPosition;
            positionToCloseSide = 'SHORT';
             // Reset the closed leg in bot state immediately
             currentLongPosition = null;
        } else if (positionSide === 'SHORT' && currentLongPosition) {
            otherPosition = currentLongPosition;
             positionToCloseSide = 'LONG';
             // Reset the closed leg in bot state immediately
             currentShortPosition = null;
        }

        if (otherPosition && positionToCloseSide) {
             // Use async function call here without awaiting to not block stream processing for too long
             closePosition(TARGET_COIN_SYMBOL, otherPosition.quantity, `Opposite leg ${positionSide} filled TP/SL`, positionToCloseSide).catch(err => {
                 addLog(`Error attempting to close other position after main TP/SL fill: ${err.message}`, true);
                  // If critical error closing the other position, bot stops.
                 if(err instanceof CriticalApiError) stopBotLogicInternal();
             });
             // Do NOT call cleanupAndResetCycle_Internal here. It will be called
             // when the closing order for the *other* position fills and reports via stream.
             // This ensures full cycle is clear before restarting.

        } else {
             addLog("No opposing position found to close or it's already gone. Proceeding with cleanup.", true);
            // If no other position to close (already closed or didn't exist), clean up now
            cleanupAndResetCycle_Internal(TARGET_COIN_SYMBOL).catch(err => {
                addLog(`Error during cleanup after single leg close: ${err.message}`, true);
                 if(err instanceof CriticalApiError) stopBotLogicInternal();
             });
        }

    }
     // If not a main TP/SL filling (e.g., partial close, or some other trade), just the PNL is updated.
     // The periodic manageOpenPosition check will handle logic based on state changes.

}

async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || (positionSide !== 'LONG' && positionSide !== 'SHORT')) return;

    if (isClosingPosition) {
        addLog(`Close in progress for ${symbol} (${positionSide}). Skipping new request.`);
        return;
    }
    isClosingPosition = true;

    addLog(`Attempting to close ${positionSide} position for ${symbol} (Reason: ${reason}).`);

    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Symbol info for ${symbol} unavailable. Cannot close.`, true);
            isClosingPosition = false;
            return;
        }
        const quantityPrecision = symbolInfo.quantityPrecision;

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} (${positionSide}) already closed on Binance. Reason: ${reason}.`);
             // Also reset local state if it wasn't already via processTradeResult
             if(positionSide === 'LONG' && currentLongPosition) currentLongPosition = null;
             if(positionSide === 'SHORT' && currentShortPosition) currentShortPosition = null;
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            if (actualQuantityToClose <= 0) {
                addLog(`Zero quantity to close for ${symbol} (${positionSide}).`, true);
                isClosingPosition = false;
                return;
            }
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';

            // Cancel existing TP/SL for this side before closing
             await cancelOpenOrdersForSymbol(symbol, null, positionSide);
            await sleep(200);

            addLog(`Sending market order to close ${closeSide} ${symbol} (${positionSide}). Qty: ${adjustedActualQuantity}`);
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                positionSide: positionSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: true, // Ensure this only closes and doesn't open reverse position
            });

            addLog(`Market close order sent for ${symbol} (${positionSide}). Reason: ${reason}.`);
            // The position state and cycle reset will be handled by processTradeResult when this order fills

        }

    } catch (error) {
        addLog(`Error closing position ${symbol} (${positionSide}): ${error.msg || error.message}`, true);
         if (error.code === -2011) {
            addLog(`-2011 received, position may have closed just before API call. Check Binance state.`);
            // Let manageOpenPosition or manual checks handle divergence
         } else if (error instanceof CriticalApiError) {
            stopBotLogicInternal();
         }
    } finally {
        isClosingPosition = false;
    }
}

async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (symbol !== TARGET_COIN_SYMBOL || (tradeDirection === 'LONG' && currentLongPosition) || (tradeDirection === 'SHORT' && currentShortPosition)) {
        // addLog(`Already tracking ${tradeDirection} position for ${symbol}. Skipping open.`); // Reduces spam
        return null;
    }

    addLog(`Preparing to open ${tradeDirection} position for ${symbol}. Capital: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`Symbol info for ${symbol} unavailable. Cannot open.`, true);
            return null;
        }

        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Failed to set leverage ${maxLeverage}x for ${symbol}. Cannot open.`, true);
            return null;
        }
        await sleep(500);

        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`Failed to get current price for ${symbol}. Cannot open.`, true);
            return null;
        }
        // addLog(`Current price for ${symbol}: ${currentPrice.toFixed(pricePrecision)}`); // Reduces spam

        const capitalToUse = INITIAL_INVESTMENT_AMOUNT;

        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity <= 0 || quantity * currentPrice < minNotional) {
            addLog(`Calculated quantity ${quantity} is too small (notional ${quantity * currentPrice}). Cannot open.`, true);
            return null;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        addLog(`Sending MARKET order to open ${tradeDirection} for ${symbol}. Qty: ${quantity}. Price: ${currentPrice.toFixed(pricePrecision)}.`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity, newOrderRespType: 'FULL'
        });

        addLog(`Market order sent for ${tradeDirection} ${symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000); // Wait briefly for order to fill

        // Get actual position details after fill
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            addLog(`Position not found on Binance after sending MARKET order for ${tradeDirection} ${symbol}.`, true);
            return null;
        }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt));
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now()));

        addLog(`Successfully opened ${tradeDirection} position for ${symbol}.`, true);
        addLog(`-> Qty: ${actualQuantity.toFixed(quantityPrecision)}, Entry: ${entryPrice.toFixed(pricePrecision)}, Leverage: ${maxLeverage}x`, true);

         // Calculate initial TP/SL prices now and store them in the position object
         let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
         if (maxLeverage >= 75) {
             TAKE_PROFIT_MULTIPLIER = 10;
             STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
             for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100);
         } else if (maxLeverage === 50) {
             TAKE_PROFIT_MULTIPLIER = 5;
             STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
             for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50);
         } else if (maxLeverage <= 25) {
             TAKE_PROFIT_MULTIPLIER = 3.5;
             STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
             for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35);
         } else {
             TAKE_PROFIT_MULTIPLIER = 3.5; // Default for others
             STOP_LOSS_MULTIPLIER = 1.75;
             for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 350);
         }

        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_MULTIPLIER;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_MULTIPLIER;

        // Recalculate price levels based on actual entry price and quantity
        const priceChangeForTP = actualQuantity > 0 ? profitTargetUSDT / actualQuantity : 0;
        const priceChangeForSL = actualQuantity > 0 ? lossLimitUSDT / actualQuantity : 0;

        let initialCalculatedSLPrice, initialCalculatedTPPrice;
         const { tickSize } = symbolDetails;


        if (tradeDirection === 'LONG') {
             initialCalculatedSLPrice = entryPrice - priceChangeForSL;
             initialCalculatedTPPrice = entryPrice + priceChangeForTP;
            // Rounding for LONG
            initialCalculatedSLPrice = Math.floor(initialCalculatedSLPrice / tickSize) * tickSize;
            initialCalculatedTPPrice = Math.floor(initialCalculatedTPPrice / tickSize) * tickSize;

        } else { // SHORT
             initialCalculatedSLPrice = entryPrice + priceChangeForSL;
             initialCalculatedTPPrice = entryPrice - priceChangeForTP;
            // Rounding for SHORT
             initialCalculatedSLPrice = Math.ceil(initialCalculatedSLPrice / tickSize) * tickSize;
             initialCalculatedTPPrice = Math.ceil(initialCalculatedTPPrice / tickSize) * tickSize;
        }
         initialCalculatedSLPrice = parseFloat(initialCalculatedSLPrice.toFixed(pricePrecision));
         initialCalculatedTPPrice = parseFloat(initialCalculatedTPPrice.toFixed(pricePrecision));


        const positionData = {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice, initialMargin: capitalToUse,
            openTime, pricePrecision, side: tradeDirection, currentPrice, unrealizedPnl: 0,
            // TP/SL IDs will be set AFTER the scheduled placement
            currentTPId: null, currentSLId: null,
            // Store calculated initial prices
            initialTPPrice: initialCalculatedTPPrice,
            initialSLPrice: initialCalculatedSLPrice,

            // Partial Close / SL adjustment states
            partialCloseLossLevels: partialCloseLossSteps, nextPartialCloseLossIndex: 0,
            closedQuantity: 0, partialClosePrices: [],
            hasRemovedInitialSL: (tradeDirection === 'LONG' && maxLeverage >= 75), // Assume high leverage LONG will have SL removed
            hasAdjustedSL6thClose: false, hasAdjustedSL8thClose: false, maxLeverageUsed: maxLeverage,
        };

         // No need to cancel orders here, cancelOpenOrdersForSymbol is done by checkAndRecreateTPAndSL


        return positionData;

    } catch (error) {
        addLog(`Error opening ${tradeDirection} position for ${symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
        // runTradingLogic handles returning null and rescheduling for non-critical errors
        return null;
    }
}


async function placeInitialTPAndSL(position) {
    if (!position || !botRunning) return;

     addLog(`Attempting to place initial TP/SL orders for ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
             addLog(`Symbol details for ${position.symbol} not available. Cannot place initial TP/SL.`);
             return;
        }

        // Get current state from Binance just before placing
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) {
            addLog(`${position.side} position for ${position.symbol} not found on Binance. Cannot place TP/SL.`, true);
             // Sync local state if necessary, though manageOpenPosition should cover this.
             if(position.side === 'LONG') currentLongPosition = null;
             if(position.side === 'SHORT') currentShortPosition = null;
             return;
        }

        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
         const { pricePrecision } = symbolDetails;

        // Use the initial calculated prices stored in the position object
        const slPrice = position.initialSLPrice;
        const tpPrice = position.initialTPPrice;

         if (actualQuantity <= 0 || !tpPrice || !slPrice) {
             addLog(`Invalid quantity (${actualQuantity}) or missing prices (${tpPrice}, ${slPrice}) for ${position.side} ${position.symbol}. Cannot place initial TP/SL.`, true);
             // Re-check this position state later? For now, just log. checkAndRecreateMissingTPAndSL might cover this.
             return;
         }


         const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';


         // --- Place SL order ---
         let placedSLOrderId = null;
         try {
            // Check if this is the winning LONG leg with high leverage. If so, skip placing SL based on the flag set in openPosition.
            if (position.side === 'LONG' && position.maxLeverageUsed >= 75) {
                addLog(`Skipping initial SL placement for LONG leg (${position.symbol}) with high leverage ${position.maxLeverageUsed}x.`);
                 position.hasRemovedInitialSL = true; // Ensure flag is true
            } else {
                 addLog(`Placing initial SL for ${position.side} ${position.symbol} @ ${slPrice.toFixed(pricePrecision)}.`);
                 const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                     symbol: position.symbol, side: orderSideToClose, positionSide: position.side,
                     type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: slPrice, closePosition: 'true', newOrderRespType: 'FULL'
                 });
                 placedSLOrderId = slOrderResult.orderId;
                 position.currentSLId = placedSLOrderId;
                 addLog(`Initial SL placed for ${position.side} ${position.symbol}. OrderId: ${placedSLOrderId}`);
                 position.hasRemovedInitialSL = false; // If successfully placed SL (meaning not the special case above), reset flag
            }
         } catch (slError) {
            addLog(`Failed to place initial SL for ${position.side} ${position.symbol}: ${slError.msg || slError.message}`, true);
            position.currentSLId = null; // Ensure local state is null on failure
             // Note: If SL triggered immediately (-2021), this would also be caught.
             // closePosition already has logic for this case. Maybe don't trigger closing here?
             // The `checkAndRecreateMissingTPAndSL` function can re-evaluate later.
             // The primary flow relies on the WebSocket 'FILLED' event for closure PNL/logic.
             if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`Initial SL immediately triggered on placement for ${position.side} ${position.symbol}. Position might be closing.`, true);
                // No need to call closePosition here, rely on the WebSocket message
            }
             if (slError instanceof CriticalApiError) throw slError; // Re-throw critical errors
         }
         await sleep(200); // Small delay

         // --- Place TP order ---
         let placedTPOrderId = null;
         try {
            addLog(`Placing initial TP for ${position.side} ${position.symbol} @ ${tpPrice.toFixed(pricePrecision)}.`);
            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                 symbol: position.symbol, side: orderSideToClose, positionSide: position.side,
                 type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: tpPrice, closePosition: 'true', newOrderRespType: 'FULL'
            });
            placedTPOrderId = tpOrderResult.orderId;
            position.currentTPId = placedTPOrderId;
            addLog(`Initial TP placed for ${position.side} ${position.symbol}. OrderId: ${placedTPOrderId}`);
         } catch (tpError) {
             addLog(`Failed to place initial TP for ${position.side} ${position.symbol}: ${tpError.msg || tpError.message}`, true);
            position.currentTPId = null; // Ensure local state is null on failure
              if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`Initial TP immediately triggered on placement for ${position.side} ${position.symbol}. Position might be closing.`, true);
                 // No need to call closePosition here
            }
            if (tpError instanceof CriticalApiError) throw tpError;
         }
         await sleep(200); // Small delay

         // No need to call checkAndRecreateMissingTPAndSL here immediately, that's scheduled after this attempt batch.


     } catch (error) {
         addLog(`Error in placeInitialTPAndSL for ${position.side} ${position.symbol}: ${error.message}`, true);
         if(error instanceof CriticalApiError) stopBotLogicInternal();
     }
}

async function checkAndRecreateMissingTPAndSL(position) {
    if (!position || !botRunning) return;

     addLog(`Checking for missing initial TP/SL for ${position.side} ${position.symbol}...`);

     try {
        // Fetch open orders on Binance
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: position.symbol });
        // Fetch current position state (quantity/entry might have changed due to partial fills if initial orders failed somehow)
         const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
         const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

         if (!currentPosOnBinance) {
              addLog(`${position.side} position for ${position.symbol} not found on Binance during re-check. Skip TP/SL re-creation.`);
              // Let manageOpenPosition or trade result handle position closing/state reset
             return;
         }

         const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
         const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice); // Get latest average entry price


         const symbolDetails = await getSymbolDetails(position.symbol);
         if (!symbolDetails) {
             addLog(`Symbol details for ${position.symbol} not available. Cannot re-create TP/SL.`);
             return;
         }
        const { pricePrecision } = symbolDetails;

        // Re-calculate expected TP/SL price based on *current* quantity and *current* entry price from Binance
        // This addresses cases where initial open might have been partial or entry averaged somehow.
        // Use stored initial multipliers but re-calculate prices on the actual position.
         const CAPITAL_BASE_FOR_TP_SL = INITIAL_INVESTMENT_AMOUNT;
         let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER; // These come from initial leverage config


         if (position.maxLeverageUsed >= 75) {
             TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
         } else if (position.maxLeverageUsed === 50) {
             TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
         } else if (position.maxLeverageUsed <= 25) {
             TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
         } else {
             TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 1.75;
         }

         const profitTargetUSDT = CAPITAL_BASE_FOR_TP_SL * TAKE_PROFIT_MULTIPLIER;
         const lossLimitUSDT = CAPITAL_BASE_FOR_TP_SL * STOP_LOSS_MULTIPLIER;

         const priceChangeForTP = actualQuantity > 0 ? profitTargetUSDT / actualQuantity : 0;
         const priceChangeForSL = actualQuantity > 0 ? lossLimitUSDT / actualQuantity : 0;

         let latestExpectedSLPrice, latestExpectedTPPrice;
         const { tickSize } = symbolDetails;


         if (position.side === 'LONG') {
             latestExpectedSLPrice = actualEntryPrice - priceChangeForSL;
             latestExpectedTPPrice = actualEntryPrice + priceChangeForTP;
            latestExpectedSLPrice = Math.floor(latestExpectedSLPrice / tickSize) * tickSize;
            latestExpectedTPPrice = Math.floor(latestExpectedTPPrice / tickSize) * tickSize;
         } else { // SHORT
             latestExpectedSLPrice = actualEntryPrice + priceChangeForSL;
             latestExpectedTPPrice = actualEntryPrice - priceChangeForTP;
             latestExpectedSLPrice = Math.ceil(latestExpectedSLPrice / tickSize) * tickSize;
             latestExpectedTPPrice = Math.ceil(latestExpectedTPPrice / tickSize) * tickSize;
         }
         latestExpectedSLPrice = parseFloat(latestExpectedSLPrice.toFixed(pricePrecision));
         latestExpectedTPPrice = parseFloat(latestExpectedTPPrice.toFixed(pricePrecision));

        // Check if the local state IDs correspond to an active order on Binance
        const hasActiveTP = position.currentTPId ? openOrders.some(o => o.orderId === position.currentTPId && o.status === 'NEW') : false;
        const hasActiveSL = position.currentSLId ? openOrders.some(o => o.orderId === position.currentSLId && o.status === 'NEW') : false;


        // If TP is missing (not in local state, or local state ID not on Binance), recreate
        if (!hasActiveTP) {
             addLog(`TP order missing for ${position.side} ${position.symbol} (CurrentID: ${position.currentTPId}). Recreating...`);
             try {
                const tpOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';
                const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: position.symbol, side: tpOrderSide, positionSide: position.side,
                    type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: latestExpectedTPPrice, closePosition: 'true', newOrderRespType: 'FULL'
                });
                position.currentTPId = tpOrderResult.orderId; // Update local state with new ID
                position.initialTPPrice = latestExpectedTPPrice; // Update stored price (though shouldn't change unless entry did)
                addLog(`TP re-created for ${position.side} ${position.symbol}. OrderId: ${tpOrderResult.orderId}, Price: ${latestExpectedTPPrice}`);
            } catch (error) {
                addLog(`Failed to re-create TP for ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
                position.currentTPId = null; // Ensure state is null on failure
                 if (error instanceof CriticalApiError) throw error;
            }
        } else {
            // TP exists, but update local state price if it was 0/missing
             if (!position.initialTPPrice || position.initialTPPrice === 0) {
                 position.initialTPPrice = latestExpectedTPPrice;
                 addLog(`Updated local initialTPPrice for ${position.side} to ${latestExpectedTPPrice}.`);
             }
            // addLog(`TP order already exists for ${position.side} ${position.symbol}. ID: ${position.currentTPId}`); // Reduces spam
        }
        await sleep(200); // Small delay

        // If SL is missing AND it should NOT be missing (i.e. not a high-leverage winning LONG that removes SL), recreate
         const shouldHaveSL = !(position.side === 'LONG' && position.maxLeverageUsed >= 75); // SL of winning high-leverage LONG is intentionally removed
        if (!hasActiveSL && shouldHaveSL) {
             addLog(`SL order missing for ${position.side} ${position.symbol} (CurrentID: ${position.currentSLId}). Recreating...`);
             try {
                const slOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';
                const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: position.symbol, side: slOrderSide, positionSide: position.side,
                    type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: latestExpectedSLPrice, closePosition: 'true', newOrderRespType: 'FULL'
                });
                position.currentSLId = slOrderResult.orderId; // Update local state
                position.initialSLPrice = latestExpectedSLPrice; // Update stored price
                position.hasRemovedInitialSL = false; // Set flag false as SL is now present
                addLog(`SL re-created for ${position.side} ${position.symbol}. OrderId: ${slOrderResult.orderId}, Price: ${latestExpectedSLPrice}`);
             } catch (error) {
                addLog(`Failed to re-create SL for ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
                position.currentSLId = null; // Ensure state is null on failure
                position.initialSLPrice = null;
                 position.hasRemovedInitialSL = true; // Set flag true on failure to place
                 if (error instanceof CriticalApiError) throw error;
             }
        } else if (hasActiveSL && shouldHaveSL) {
             // SL exists and should, update local state price if it was 0/missing
             if (!position.initialSLPrice || position.initialSLPrice === 0) {
                 position.initialSLPrice = latestExpectedSLPrice;
                 addLog(`Updated local initialSLPrice for ${position.side} to ${latestExpectedSLPrice}.`);
             }
            // addLog(`SL order already exists for ${position.side} ${position.symbol}. ID: ${position.currentSLId}`); // Reduces spam
        } else if (!shouldHaveSL) {
             // SL should not exist for this position/leverage, ensure local state reflects this
             if (position.currentSLId !== null || position.initialSLPrice !== null || position.hasRemovedInitialSL === false) {
                 addLog(`SL should not exist for ${position.side} ${position.symbol} (${position.maxLeverageUsed}x). Resetting local state.`);
                  position.currentSLId = null;
                  position.initialSLPrice = null;
                  position.hasRemovedInitialSL = true;
             }
        }


    } catch (error) {
        addLog(`Error during checkAndRecreateMissingTPAndSL for ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
         if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

// New function to schedule initial TP/SL placement after positions are opened
async function scheduleInitialTPAndSLPlacement() {
    if (!botRunning || !currentLongPosition || !currentShortPosition) {
         // AddLog("Conditions not met to schedule initial TP/SL placement."); // Reduce spam
         return;
     }

    addLog(`Scheduling initial TP/SL placement in 5 seconds.`);
     // Schedule the first attempt 5 seconds after both positions are recorded
    setTimeout(async () => {
        if (!botRunning) return;
        addLog(`Attempting initial TP/SL placement.`);
         try {
            // Check if positions still exist just before placing
             if(currentLongPosition) await placeInitialTPAndSL(currentLongPosition);
             if(currentShortPosition) await placeInitialTPAndSL(currentShortPosition);

             // After the initial attempt, schedule a re-check after 20 seconds
             if(botRunning && (currentLongPosition || currentShortPosition)){ // Only schedule re-check if at least one position still exists locally
                 addLog(`Scheduling missing TP/SL check in 20 seconds.`);
                setTimeout(async () => {
                    if (!botRunning) return;
                    addLog(`Attempting re-check and re-creation of missing initial TP/SL.`);
                     if(currentLongPosition) await checkAndRecreateMissingTPAndSL(currentLongPosition);
                     if(currentShortPosition) await checkAndRecreateMissingTPAndSL(currentShortPosition);
                }, 20000); // 20 seconds after the 5-second mark
             }


         } catch (error) {
            addLog(`Error during initial TP/SL placement attempt: ${error.message}`, true);
             // If a critical error occurred placing initial orders, stop bot (should be propagated)
             if (error instanceof CriticalApiError) stopBotLogicInternal();
         }
    }, 5000); // 5 seconds delay
}


async function addPosition(position, quantityToReopen, reason) {
    if (!position || quantityToReopen <= 0) {
        addLog(`Invalid params for addPosition.`);
        return;
    }
     // Ensure position still exists on Binance before attempting to add
    const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
    const currentPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);
     if(!currentPositionOnBinance) {
         addLog(`${position.side} position for ${position.symbol} not found on Binance. Cannot add.`, true);
         if(position.side === 'LONG' && currentLongPosition) currentLongPosition = null;
         if(position.side === 'SHORT' && currentShortPosition) currentShortPosition = null;
         return;
     }


    addLog(`Adding ${quantityToReopen.toFixed(position.quantityPrecision)} quantity to ${position.side} position for ${position.symbol} (Reason: ${reason}).`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Symbol details for ${position.symbol} not available. Cannot add.`, true);
            return;
        }

        const { quantityPrecision, minNotional, stepSize } = symbolDetails;
        const currentPrice = await getCurrentPrice(position.symbol);
        if (!currentPrice) {
            addLog(`Current price for ${position.symbol} not available. Cannot add.`, true);
            return;
        }

        const maxLeverage = position.maxLeverageUsed; // Use stored leverage
        if (!maxLeverage) {
            addLog(`Leverage not stored for ${position.symbol}. Cannot add.`, true);
            return;
        }

         let adjustedQuantityToReopen = Math.floor(quantityToReopen / stepSize) * stepSize;
         adjustedQuantityToReopen = parseFloat(adjustedQuantityToReopen.toFixed(quantityPrecision));

        if (adjustedQuantityToReopen <= 0 || adjustedQuantityToReopen * currentPrice < minNotional) {
            addLog(`Adjusted quantity to add (${adjustedQuantityToReopen}) or notional (${adjustedQuantityToReopen * currentPrice}) too small. Cannot add.`, true);
            return;
        }

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';

        addLog(`Sending MARKET order to add ${adjustedQuantityToReopen} for ${position.side} ${position.symbol}.`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: adjustedQuantityToReopen,
             // Do NOT set reduceOnly for adding position
            newOrderRespType: 'FULL'
        });

        addLog(`Add position order sent for ${position.side} ${position.symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000); // Wait for fill confirmation (PNL 0 trade event from WS should come)

        // Refresh position state from Binance *after* order fills (PNL 0 event is best trigger, but periodically checking also works)
        // manageOpenPosition interval handles syncing entry price and quantity periodically.

        // Reset relevant state flags and counters after adding position, assuming it successfuly re-balanced
         addLog(`Resetting partial close/SL state for both legs after addPosition.`);
         // Reset state for both Long and Short positions as they represent the coupled trade
         [currentLongPosition, currentShortPosition].forEach(p => {
            if (p) {
                 p.nextPartialCloseLossIndex = 0;
                 p.closedQuantity = 0;
                 p.partialClosePrices = [];
                 p.hasAdjustedSL6thClose = false;
                 p.hasAdjustedSL8thClose = false;
                // hasRemovedInitialSL will be set to false if updateTPandSLForTotalPosition successfully places SL
            }
         });

         // Recalculate and re-place TP/SL for BOTH legs based on their *new* combined quantity and average entry.
         addLog(`Recalculating and replacing TP/SL for both legs.`);
         if (currentLongPosition) await updateTPandSLForTotalPosition(currentLongPosition, currentLongPosition.maxLeverageUsed);
         if (currentShortPosition) await updateTPandSLForTotalPosition(currentShortPosition, currentShortPosition.maxLeverageUsed);


    } catch (error) {
        addLog(`Error adding position to ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) {
            stopBotLogicInternal();
        }
    }
}

// Recalculates TP/SL price points and attempts to place orders. Used after Open or AddPosition.
// TP/SL prices should *not* be recalculated here every check, only when qty/entry actually changes significantly (after adding position)
async function recalculateAndPlaceTPAndSL(position) {
    if (!position || !botRunning) return;

    addLog(`Recalculating & Replacing TP/SL for ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Symbol details for ${position.symbol} not available. Cannot set TP/SL.`, true);
            return;
        }
        const { pricePrecision, tickSize } = symbolDetails;

         // Get current state from Binance *just before* recalculating based on real data
         const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
         const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) {
            addLog(`${position.side} position for ${position.symbol} not found on Binance. Cannot set TP/SL.`, true);
             if(position.side === 'LONG' && currentLongPosition) currentLongPosition = null;
             if(position.side === 'SHORT' && currentShortPosition) currentShortPosition = null;
            return;
        }
        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);

        // Recalculate based on *current* actual data on Binance and original parameters
         const CAPITAL_BASE_FOR_TP_SL = INITIAL_INVESTMENT_AMOUNT; // Always based on initial investment per leg
         let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER; // These multipliers come from initial leverage config

        if (position.maxLeverageUsed >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
        } else if (position.maxLeverageUsed === 50) {
            TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
        } else if (position.maxLeverageUsed <= 25) {
            TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2;
        } else {
            TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 1.75;
        }

         const profitTargetUSDT = CAPITAL_BASE_FOR_TP_SL * TAKE_PROFIT_MULTIPLIER;
         const lossLimitUSDT = CAPITAL_BASE_FOR_TP_SL * STOP_LOSS_MULTIPLIER;

        // Ensure actualQuantity > 0 to avoid division by zero
         if (actualQuantity <= 0) {
            addLog(`Actual quantity is 0 for ${position.side} ${position.symbol}. Cannot calculate TP/SL prices.`, true);
             await cancelOpenOrdersForSymbol(position.symbol, null, position.side); // Clean up any old orders just in case
             position.currentSLId = null; position.initialSLPrice = null; position.currentTPId = null; position.initialTPPrice = 0; // Reset local state prices/IDs
             return;
         }

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;


        let newSLPrice, newTPPrice;

        if (position.side === 'LONG') {
            newSLPrice = actualEntryPrice - priceChangeForSL;
            newTPPrice = actualEntryPrice + priceChangeForTP;
             newSLPrice = Math.floor(newSLPrice / tickSize) * tickSize;
            newTPPrice = Math.floor(newTPPrice / tickSize) * tickSize;
        } else { // SHORT
            newSLPrice = actualEntryPrice + priceChangeForSL;
            newTPPrice = actualEntryPrice - priceChangeForTP;
             newSLPrice = Math.ceil(newSLPrice / tickSize) * tickSize;
             newTPPrice = Math.ceil(newTPPrice / tickSize) * tickSize;
        }

        newSLPrice = parseFloat(newSLPrice.toFixed(pricePrecision));
        newTPPrice = parseFloat(newTPPrice.toFixed(pricePrecision));


        // Hủy TP/SL cũ và đặt lại
        await cancelOpenOrdersForSymbol(position.symbol, null, position.side);
        await sleep(500);

        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';

         // Place SL (conditionally for winning LONG with high leverage)
         let placedSLOrderId = null;
         try {
             if (position.side === 'LONG' && position.maxLeverageUsed >= 75 && !position.hasAdjustedSL6thClose && !position.hasAdjustedSL8thClose) {
                 addLog(`Skipping SL placement for LONG leg (${position.symbol}) with high leverage ${position.maxLeverageUsed}x unless SL adjustment levels are reached.`);
                // Don't place SL here if it's the initial high-leverage LONG leg and no adjustments happened yet
                 position.currentSLId = null;
                 position.initialSLPrice = null; // Local price reflects no SL is expected
                 position.hasRemovedInitialSL = true; // Ensure this flag is true
            } else {
                // For SHORT leg, OR LONG leg after level 6/8 adjustments, always place SL based on the *newly calculated* price (unless specific adjustment overrides).
                 // This logic might need refinement based on desired SL behavior AFTER addPosition / Partial close / Adjustments
                 // Current assumption: After addPosition, both legs get TP/SL calculated from new entry/qty,
                 // BUT subsequent SL adjustments still override this based on partial close levels.
                 // To keep it simpler: Recalculate base SL price here. `updateStopLoss` handles level-based overrides.
                 let finalSLPriceForOrder = newSLPrice;

                 // Check if level-based adjustments should override the calculated price (based on winningPos flags, acting on both positions)
                 // Find winning/losing positions in local state to check flags/partialClosePrices
                 let winningPosLocal = (currentLongPosition && currentShortPosition && currentLongPosition.unrealizedPnl > 0) ? currentLongPosition : (currentLongPosition && currentShortPosition && currentShortPosition.unrealizedPnl > 0) ? currentShortPosition : null;
                 let losingPosLocal = (currentLongPosition && currentShortPosition && currentLongPosition.unrealizedPnl < 0) ? currentLongPosition : (currentLongPosition && currentShortPosition && currentShortPosition.unrealizedPnl < 0) ? currentShortPosition : null;

                 // Only apply adjustments if both positions still exist locally
                 if (winningPosLocal && losingPosLocal) {
                    if (winningPosLocal.partialClosePrices.length >= 2 && winningPosLocal.hasAdjustedSL6thClose) {
                        finalSLPriceForOrder = losingPosLocal.partialClosePrices[1];
                         addLog(`Overriding SL price for ${position.side} with level 6 adjustment price (${finalSLPriceForOrder}).`);
                     }
                     if (winningPosLocal.partialClosePrices.length >= 5 && winningPosLocal.hasAdjustedSL8thClose && position.side === winningPosLocal.side) {
                        finalSLPriceForOrder = losingPosLocal.partialClosePrices[4];
                        addLog(`Overriding SL price for winning leg ${position.side} with level 8 adjustment price (${finalSLPriceForOrder}).`);
                     }
                 }


                // Check for invalid calculated/adjusted SL price before placing
                 const isSLInvalid = (position.side === 'LONG' && finalSLPriceForOrder >= actualEntryPrice) || (position.side === 'SHORT' && finalSLPriceForOrder <= actualEntryPrice);
                if (isSLInvalid) {
                    addLog(`Calculated/Adjusted SL price (${finalSLPriceForOrder}) is invalid for ${position.side}. Not placing SL order.`, true);
                     position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;
                 } else {
                     addLog(`Placing SL for ${position.side} ${position.symbol} @ ${finalSLPriceForOrder.toFixed(pricePrecision)}.`);
                    const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: position.symbol, side: orderSideToClose, positionSide: position.side,
                        type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: finalSLPriceForOrder, closePosition: 'true', newOrderRespType: 'FULL'
                    });
                    placedSLOrderId = slOrderResult.orderId;
                    position.currentSLId = placedSLOrderId;
                    position.initialSLPrice = finalSLPriceForOrder; // Store the placed price
                    position.hasRemovedInitialSL = false; // Set flag false if SL is now present
                    addLog(`SL placed for ${position.side} ${position.symbol}. OrderId: ${placedSLOrderId}`);
                }
            }

        } catch (slError) {
             addLog(`Failed to place SL for ${position.side} ${position.symbol}: ${slError.msg || slError.message}`, true);
             position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;
             if (slError instanceof CriticalApiError) throw slError;
        }
        await sleep(200); // Small delay

        // Place TP (always based on the new calculated price, TP price doesn't get overridden by partial close levels)
         let placedTPOrderId = null;
         try {
             const isTPInvalid = (position.side === 'LONG' && newTPPrice <= actualEntryPrice) || (position.side === 'SHORT' && newTPPrice >= actualEntryPrice);
             if(isTPInvalid) {
                  addLog(`Calculated TP price (${newTPPrice}) is invalid for ${position.side}. Not placing TP order.`, true);
                  position.currentTPId = null; position.initialTPPrice = 0;
             } else {
                 addLog(`Placing TP for ${position.side} ${position.symbol} @ ${newTPPrice.toFixed(pricePrecision)}.`);
                 const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                     symbol: position.symbol, side: orderSideToClose, positionSide: position.side,
                     type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: newTPPrice, closePosition: 'true', newOrderRespType: 'FULL'
                 });
                 placedTPOrderId = tpOrderResult.orderId;
                 position.currentTPId = placedTPOrderId;
                 position.initialTPPrice = newTPPrice; // Store the placed price
                 addLog(`TP placed for ${position.side} ${position.symbol}. OrderId: ${placedTPOrderId}`);
             }
         } catch (tpError) {
             addLog(`Failed to place TP for ${position.side} ${position.symbol}: ${tpError.msg || tpError.message}`, true);
             position.currentTPId = null; // Ensure state is null on failure
             position.initialTPPrice = 0;
             if (tpError instanceof CriticalApiError) throw tpError;
         }
        await sleep(200); // Small delay

    } catch (error) {
        addLog(`Error in recalculateAndPlaceTPAndSL for ${position.side} ${position.symbol}: ${error.message}`, true);
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
}


async function updateStopLoss(position, targetSLPrice) {
    if (!position || !botRunning) return;

    // Only perform update if position exists on Binance AND targetSLPrice is provided (not just cancelling)
    if (targetSLPrice !== null) {
        // Check if position exists on Binance before API call
         const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
         const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
         if (!currentPosOnBinance) {
            addLog(`${position.side} position for ${position.symbol} not found on Binance. Cannot update SL.`, true);
             // Also update local state if necessary
             if(position.side === 'LONG' && currentLongPosition) currentLongPosition = null;
             if(position.side === 'SHORT' && currentShortPosition) currentShortPosition = null;
            return;
        }

        // Check if targetSLPrice is invalid compared to current entry price on Binance
         const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);
         const isSLInvalid = (position.side === 'LONG' && targetSLPrice >= actualEntryPrice) || (position.side === 'SHORT' && targetSLPrice <= actualEntryPrice);
         if (isSLInvalid) {
             addLog(`Attempted SL price (${targetSLPrice}) is invalid for ${position.side} (current entry ${actualEntryPrice}). Skipping update.`, true);
            // Don't set position state to null, just indicate SL is missing
            position.currentSLId = null;
            position.initialSLPrice = null; // Or initialSLPrice = targetSLPrice but indicate it failed? Let's set to null if not placed.
             position.hasRemovedInitialSL = true; // Assume SL is now not present

             return;
         }
    }


     addLog(`Updating SL for ${position.side} ${position.symbol}${targetSLPrice !== null ? ` to ${targetSLPrice.toFixed(position.pricePrecision)}` : ''}.`);


    // Cancel existing SL order for this side
    if (position.currentSLId) {
        addLog(`Cancelling existing SL order ${position.currentSLId}.`);
        try {
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side);
             position.currentSLId = null; // Update local state immediately after trying to cancel
             // position.initialSLPrice = null; // Don't clear initialSLPrice, it might be needed to track the original or target price level
        } catch (error) {
             // Log non-2011 errors but don't necessarily stop the process
             if (error.code !== -2011) {
                 addLog(`Error cancelling old SL (${position.currentSLId}): ${error.msg || error.message}`, true);
                  if (error instanceof CriticalApiError) throw error;
             }
        }
         await sleep(300); // Give cancellation a moment


        // Set flag that initial SL was removed *if* this is the initial removal step for a winning leg.
        // This logic needs to be careful not to interfere with level-based adjustments.
        // `hasRemovedInitialSL` is primarily used to track if the *first ever* SL (for winning leg) was removed.
        // When updating SL due to levels, this flag probably shouldn't change.
        // Let's set it true only when targetSLPrice is null (explicit cancellation) AND it was the initial winning leg SL that got cancelled.
         let isCurrentPosWinning = false;
         if (currentLongPosition && currentLongPosition.symbol === position.symbol && currentLongPosition.unrealizedPnl > 0) isCurrentPosWinning = true;
         if (currentShortPosition && currentShortPosition.symbol === position.symbol && currentShortPosition.unrealizedPnl > 0) isCurrentPosWinning = true;

        if (targetSLPrice === null && isCurrentPosWinning && !position.hasRemovedInitialSL) {
             addLog(`Flagging hasRemovedInitialSL for winning leg ${position.side}.`);
            position.hasRemovedInitialSL = true;
        }
        // If we are placing a new SL (targetSLPrice != null), the initial SL is no longer "the initial SL" but rather overridden.
        // Resetting hasRemovedInitialSL = false seems appropriate *if a new SL is successfully placed*.
         // Logic for setting hasRemovedInitialSL on successful placement will be in the placement try block.

    }


    // If a target price is provided, place the new SL order
    if (targetSLPrice !== null && botRunning) {
        try {
            // Re-fetch quantity and entry price just before placing for highest accuracy
             const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
             const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
             if (!currentPosOnBinance) {
                addLog(`${position.side} position not found during new SL placement. Skipping.`, true);
                 if(position.side === 'LONG' && currentLongPosition) currentLongPosition = null;
                 if(position.side === 'SHORT' && currentShortPosition) currentShortPosition = null;
                 return;
             }
             const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
             const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);

            // Double check invalid price based on actual entry price before final attempt
             const isSLInvalid = (position.side === 'LONG' && targetSLPrice >= actualEntryPrice) || (position.side === 'SHORT' && targetSLPrice <= actualEntryPrice);
             if (isSLInvalid) {
                 addLog(`New SL price (${targetSLPrice}) is invalid for ${position.side}. Not placing.`, true);
                  position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true; // Mark as not having SL
                 return;
             }


            const slOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol, side: slOrderSide, positionSide: position.side,
                type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: targetSLPrice, closePosition: 'true', newOrderRespType: 'FULL'
            });
            position.currentSLId = slOrderResult.orderId; // Update local state with new ID
             // position.initialSLPrice = targetSLPrice; // Only update initialSLPrice if this *is* the initial SL? Or track latest? Let's track latest effective SL price.
             position.initialSLPrice = targetSLPrice; // Use initialSLPrice to store the *current* effective SL price
            position.hasRemovedInitialSL = false; // Flag is false if an SL is currently placed.
             addLog(`New SL placed for ${position.side} ${position.symbol} @ ${targetSLPrice.toFixed(position.pricePrecision)}. OrderId: ${slOrderResult.orderId}`);

        } catch (slError) {
            addLog(`Failed to place new SL for ${position.side} ${position.symbol}: ${slError.msg || slError.message}`, true);
            position.currentSLId = null; // Ensure state is null on failure
            position.initialSLPrice = null;
            position.hasRemovedInitialSL = true; // If placement failed, SL is not active
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                 addLog(`New SL immediately triggered on placement. Position may be closing.`, true);
                // No need to call closePosition here.
            }
            if (slError instanceof CriticalApiError) throw slError;
        }
        await sleep(200);
    }
    // If targetSLPrice is null, we already cancelled the old one above. No need to place.
}


const manageOpenPosition = async () => {
    if (!botRunning || (!currentLongPosition && !currentShortPosition)) {
        if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
         if(botRunning && !currentLongPosition && !currentShortPosition) scheduleNextMainCycle();
        return;
    }

    if (isClosingPosition) { return; }

    try {
        // Get live positions from Binance
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        let hasActivePositionAfterSync = false;

        // Sync state for LONG
        if (currentLongPosition) {
             const longPosOnBinance = positionsOnBinance.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'LONG' && parseFloat(p.positionAmt) !== 0);
             if (!longPosOnBinance) {
                  addLog(`LONG position closed on Binance.`, true);
                  currentLongPosition = null;
             } else {
                  // Update local state with live data
                  currentLongPosition.unrealizedPnl = parseFloat(longPosOnBinance.unRealizedProfit);
                  currentLongPosition.currentPrice = parseFloat(longPosOnBinance.markPrice);
                  currentLongPosition.quantity = Math.abs(parseFloat(longPosOnBinance.positionAmt));
                  currentLongPosition.entryPrice = parseFloat(longPosOnBinance.entryPrice); // Keep entry price updated
                  hasActivePositionAfterSync = true;
             }
        }

        // Sync state for SHORT
        if (currentShortPosition) {
            const shortPosOnBinance = positionsOnBinance.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) !== 0);
             if (!shortPosOnBinance) {
                  addLog(`SHORT position closed on Binance.`, true);
                  currentShortPosition = null;
             } else {
                 currentShortPosition.unrealizedPnl = parseFloat(shortPosOnBinance.unRealizedProfit);
                 currentShortPosition.currentPrice = parseFloat(shortPosOnBinance.markPrice);
                 currentShortPosition.quantity = Math.abs(parseFloat(shortPosOnBinance.positionAmt));
                 currentShortPosition.entryPrice = parseFloat(shortPosOnBinance.entryPrice);
                 hasActivePositionAfterSync = true;
            }
        }

        // If no positions active after sync, clean up and schedule new cycle
        if (!hasActivePositionAfterSync) {
             addLog(`No active positions for ${TARGET_COIN_SYMBOL} on Binance.`, true);
             if (currentLongPosition || currentShortPosition) { addLog(`Local state had positions. Forcing reset.`, true); }
             currentLongPosition = null; currentShortPosition = null;
             // Cleanup and reset cycle should trigger when the *final* position reports filled via WS.
             // If somehow WS fails or position is liquidated/removed without stream notification,
             // this check here acts as a failsafe to eventually trigger cleanup.
            await cleanupAndResetCycle_Internal(TARGET_COIN_SYMBOL); // Check/Close leftovers & Schedule new cycle
            return;
        }

        // Logic below only runs if both positions are present *in local state* (and synced to >0 on Binance)
        if (currentLongPosition && currentShortPosition) {

            let winningPos = null;
            let losingPos = null;

            if (currentLongPosition.unrealizedPnl > 0 && currentShortPosition.unrealizedPnl < 0) {
                winningPos = currentLongPosition; losingPos = currentShortPosition;
            } else if (currentShortPosition.unrealizedPnl > 0 && currentLongPosition.unrealizedPnl < 0) {
                winningPos = currentShortPosition; losingPos = currentLongPosition;
            } else {
                 // addLog(`Both positions PNL not in winning/losing pair.`); // Reduce spam
                 return;
            }


            const symbolDetails = await getSymbolDetails(winningPos.symbol);
            const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;

            const currentProfitPercentage = winningPos.initialMargin > 0 ? (winningPos.unrealizedPnl / winningPos.initialMargin) * 100 : 0;

            // Cancel Initial SL for Winning Leg if High Leverage AND Has Profit AND SL is Present AND Flag Not Set
             if (winningPos.side === 'LONG' && winningPos.maxLeverageUsed >= 75 && winningPos.currentSLId && !winningPos.hasRemovedInitialSL && currentProfitPercentage > 0.5) {
                 addLog(`Winning LONG leg (${winningPos.symbol}) with high leverage has profit (${currentProfitPercentage.toFixed(2)}%). Canceling initial SL.`, true);
                 await updateStopLoss(winningPos, null); // Cancels and sets hasRemovedInitialSL=true
                 // The SL ID in winningPos state will be set to null within updateStopLoss.
            }


            // Partial Close Logic for Losing Leg (triggered by Winning Leg Profit)
            const losingPosIndex = losingPos.nextPartialCloseLossIndex;
            const nextLossCloseLevel = losingPos.partialCloseLossLevels[losingPosIndex];

             // Check if target level is reached AND we haven't already processed this level (index < 8)
             if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel && losingPosIndex < 8) {
                 addLog(`Winning leg ${winningPos.symbol} reached ${nextLossCloseLevel}% profit. Attempting to close 10% of losing leg ${losingPos.symbol}.`, true);
                 // Check quantity before attempting partial close
                 const losingSymbolInfo = await getSymbolDetails(losingPos.symbol);
                 if (!losingSymbolInfo) { addLog(`Symbol info for losing leg ${losingPos.symbol} not available. Cannot partially close.`, true); return; }

                 let quantityToAttemptClose = losingPos.initialQuantity * 0.10; // Based on Initial Quantity
                 quantityToAttemptClose = Math.floor(quantityToAttemptClose / losingSymbolInfo.stepSize) * losingSymbolInfo.stepSize;
                 quantityToAttemptClose = parseFloat(quantityToAttemptClose.toFixed(losingSymbolInfo.quantityPrecision));

                if (Math.abs(parseFloat(currentPosOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')) >= quantityToAttemptClose && quantityToAttemptClose > 0) {
                    await closePartialPosition(losingPos, 10, 'LOSS');
                    // Update index *after* attempting the close (regardless of fill status, indicates the level trigger happened)
                    losingPos.nextPartialCloseLossIndex++;
                    winningPos.nextPartialCloseLossIndex = losingPos.nextPartialCloseLossIndex; // Keep in sync
                } else {
                     if(Math.abs(parseFloat(currentPosOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')) > 0){
                          addLog(`Losing leg quantity (${Math.abs(parseFloat(currentPosOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0'))}) too small for partial close ${losingPosIndex + 1}. Skipping.`);
                     } else {
                          addLog(`Losing leg ${losingPos.symbol} already closed (qty 0). Skipping partial close ${losingPosIndex + 1}.`);
                          // Since losing leg is closed, update index to max to skip future partial close attempts
                           if(losingPosIndex < 8) {
                             losingPos.nextPartialCloseLossIndex = 8;
                              winningPos.nextPartialCloseLossIndex = 8; // Sync
                           }
                     }
                }
             } else if (losingPosIndex >= 8 && Math.abs(parseFloat(currentPosOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')) > 0) {
                 // If attempted 8 times and losing leg is *still* open on Binance (flesh out failsafe logic if partial closes failed repeatedly)
                 addLog(`Attempted 8 partial closes on losing leg, but position still open. Force closing remaining.`, true);
                 await closePosition(losingPos.symbol, Math.abs(parseFloat(currentPosOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')), 'Force close after 8 partials', losingPos.side);
                 // state will be set to null by processTradeResult
             }


             // SL Adjustment Logic (Triggered by Partial Close Levels)
             const partialCloseCount = winningPos.nextPartialCloseLossIndex; // Use synchronized index

             // Level 6 Adjustment: Adjust SL for BOTH legs to losing leg's entry price at 2nd partial close (index 1)
             if (partialCloseCount >= 6 && !winningPos.hasAdjustedSL6thClose) {
                 // Check if 2nd partial close price (index 1) is available in losingPos.partialClosePrices
                 if (losingPos.partialClosePrices.length >= 2) {
                    const slTargetPrice = losingPos.partialClosePrices[1];
                    addLog(`Level ${partialCloseCount} reached. Adjusting SL for both legs to losing leg's price at 2nd partial close (${slTargetPrice.toFixed(pricePrecision)}).`, true);

                     // Update SL for Long if exists
                     if (currentLongPosition) await updateStopLoss(currentLongPosition, slTargetPrice);
                     else addLog('LONG position not found for Level 6 SL adjustment.');

                     // Update SL for Short if exists
                     if (currentShortPosition) await updateStopLoss(currentShortPosition, slTargetPrice);
                     else addLog('SHORT position not found for Level 6 SL adjustment.');

                    winningPos.hasAdjustedSL6thClose = true; // Set flag on the winning leg
                 } else {
                     addLog(`Not enough partialClosePrices (${losingPos.partialClosePrices.length}) for Level 6 SL adjustment (need index 1).`);
                 }
             }

            // Level 8 Adjustment: Adjust SL for WINNING leg ONLY to losing leg's entry price at 5th partial close (index 4)
            // This happens after the losing leg has been attempted to be closed 8 times.
             if (partialCloseCount >= 8 && !winningPos.hasAdjustedSL8thClose && winningPos) { // Ensure winningPos exists
                 // Check if 5th partial close price (index 4) is available in losingPos.partialClosePrices
                 if (losingPos.partialClosePrices.length >= 5) {
                    const slTargetPrice = losingPos.partialClosePrices[4];
                    addLog(`Level ${partialCloseCount} reached. Losing leg should be closing. Adjusting SL for winning leg ${winningPos.side} to losing leg's price at 5th partial close (${slTargetPrice.toFixed(pricePrecision)}).`, true);
                     await updateStopLoss(winningPos, slTargetPrice);
                    winningPos.hasAdjustedSL8thClose = true; // Set flag on the winning leg
                 } else {
                     addLog(`Not enough partialClosePrices (${losingPos.partialClosePrices.length}) for Level 8 SL adjustment (need index 4).`);
                 }
            }

            // Add Position Logic: Winning leg profit returns to 0% after reaching levels > 0 and partial loss closed, ADD BACK to LOSING LEG
             // Only check if both legs exist and partial closes were ever attempted (index > 0) and not all 8 levels processed (index <= 7)
             if (winningPos && losingPos && winningPos.nextPartialCloseLossIndex > 0 && winningPos.nextPartialCloseLossIndex <= 7) {
                 const currentWinningProfitPercentage = winningPos.initialMargin > 0 ? (winningPos.unrealizedPnl / winningPos.initialMargin) * 100 : 0;
                 // Check if winning leg is at or near 0% profit AND losing leg had quantity partially closed
                 if (currentWinningProfitPercentage <= 0.1 && losingPos.closedQuantity > 0) { // 0.1% threshold
                    addLog(`Winning leg profit returned to ${currentWinningProfitPercentage.toFixed(2)}%. Adding back ${losingPos.closedQuantity} to losing leg ${losingPos.symbol}.`, true);
                     // Pass losingPos and its closedQuantity to addPosition
                     await addPosition(losingPos, losingPos.closedQuantity, 'Winning leg profit reverted');
                    // addPosition will reset relevant flags and counters in BOTH legs.
                 }
             }


        } else {
             // addLog('Waiting for both positions to be open for logic execution.'); // Reduce spam
        }


    } catch (error) {
        addLog(`Error in manageOpenPosition for ${TARGET_COIN_SYMBOL}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
         // Non-critical errors don't stop interval.
    }
}


async function scheduleNextMainCycle() {
    if (!botRunning) { return; }
    clearTimeout(nextScheduledCycleTimeout);

    // Re-check actual positions on Binance before deciding the next step
     try {
         const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

        if (positionsOnBinance.length > 0 || currentLongPosition || currentShortPosition) {
             // Positions are found or already in state, ensure interval is running
             // Update local state from live data if necessary (manageOpenPosition will do this in the interval)
             addLog(`Positions active (${positionsOnBinance.length} on Binance, ${!!currentLongPosition} local LONG, ${!!currentShortPosition} local SHORT). Ensuring monitor interval runs.`);
            if (!positionCheckInterval && botRunning) {
                 addLog(`Starting position monitor interval.`);
                 positionCheckInterval = setInterval(async () => {
                    if (botRunning && (currentLongPosition || currentShortPosition)) {
                        try { await manageOpenPosition(); }
                        catch (error) {
                             addLog(`Interval error: ${error.message}`, true);
                             if (error instanceof CriticalApiError) stopBotLogicInternal();
                        }
                    } else if (!botRunning && positionCheckInterval) {
                         clearInterval(positionCheckInterval); positionCheckInterval = null; addLog('Interval stopped due to bot state.');
                    } else if (!currentLongPosition && !currentShortPosition && positionCheckInterval) { // Local state reset by manageOpenPosition or cleanup
                         clearInterval(positionCheckInterval); positionCheckInterval = null; addLog('Interval stopped as no local positions.');
                         if(botRunning) scheduleNextMainCycle(); // Schedule new main cycle if still running
                    }
                }, 5000); // Check every 5 seconds
            }
             // Do NOT schedule runTradingLogic if positions exist.
        } else {
            // No positions found on Binance and locally. Schedule the main trading logic to open new positions.
             addLog(`No active positions. Scheduling new trading cycle in 2 seconds.`);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
        }
     } catch (error) {
         addLog(`Error checking positions before scheduling cycle: ${error.msg || error.message}`, true);
         if(error instanceof CriticalApiError) stopBotLogicInternal();
         else { // Non-critical API error checking status, retry scheduling check after 5s
             addLog(`Retrying schedule check in 5 seconds after error.`);
             nextScheduledCycleTimeout = setTimeout(scheduleNextMainCycle, 5000);
         }
     }
}

async function getListenKey() {
    if (!API_KEY || !SECRET_KEY) { addLog("API Key/Secret not configured.", true); return null; }
    try {
        const data = await callSignedAPI('/fapi/v1/listenKey', 'POST');
        addLog(`Fetched new listenKey.`);
        return data.listenKey;
    } catch (error) {
        addLog(`Error fetching listenKey: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
        return null;
    }
}

async function keepAliveListenKey() {
    if (!listenKey) {
         // addLog("No listenKey to keep alive. Trying to fetch."); // Reduces spam
         try {
            listenKey = await getListenKey(); // Will throw Critical if key is bad
            if (listenKey) {
                setupUserDataStream(listenKey); // This will restart interval
            }
         } catch(e) { /* Handled by getListenKey Critical error or stream setup error */ }
        return;
    }
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey });
        // addLog('ListenKey refreshed.'); // Too frequent log
    } catch (error) {
         addLog(`Error refreshing listenKey: ${error.msg || error.message}`, true);
        if (error.code === -1000 || error.code === -1125) {
            addLog(`ListenKey invalid or expired (${error.code}). Fetching new key and reconnecting.`, true);
             if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
             listenKeyRefreshInterval = null;
            userDataWs?.close(); userDataWs = null; listenKey = null;
            try {
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
            } catch (e) {
                 addLog(`Error fetching new listenKey after refresh failure: ${e.message}`, true);
                 if(e instanceof CriticalApiError) throw e;
            }
        } else if (error instanceof CriticalApiError) {
             throw error;
        }
    }
}

function setupMarketDataStream(symbol) {
    if (!botRunning) { if (marketWs) marketWs.close(); marketWs = null; return; }
    if (marketWs) { marketWs.close(); marketWs = null; }

    const streamSymbol = symbol.toLowerCase();
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${streamSymbol}@markPrice@1s`;

    addLog(`Connecting Market WebSocket to ${streamUrl}.`);
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => { addLog(`Market WebSocket for ${symbol} connected.`); };
    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'markPriceUpdate' && data.s === TARGET_COIN_SYMBOL.toUpperCase()) {
                currentMarketPrice = parseFloat(data.p);
                if (currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice;
                if (currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice;
            }
        } catch (e) { /* addLog(`Market WS parse error: ${e.message}`); // Reduces spam */ }
    };
    marketWs.onerror = (error) => {
        addLog(`Market WebSocket error for ${symbol}: ${error.message}. Reconnecting in 5s...`, true);
        marketWs = null;
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
    marketWs.onclose = (event) => {
        addLog(`Market WebSocket for ${symbol} closed. Code: ${event.code}, Reason: ${event.reason}. Reconnecting in 5s...`, true);
        marketWs = null;
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000);
    };
}

function setupUserDataStream(key) {
    if (!botRunning) { if (userDataWs) userDataWs.close(); userDataWs = null; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; return; }
    if (userDataWs) { userDataWs.close(); userDataWs = null; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;}

    if (!key) { addLog("No listenKey provided for User Data WebSocket setup.", true); return; }

    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    addLog(`Connecting User Data WebSocket to ${streamUrl}.`);
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('User Data WebSocket connected.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 1800000); // 30 mins
    };
    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE' && data.o?.s === TARGET_COIN_SYMBOL.toUpperCase()) {
                const order = data.o;
                 // Add minimal log for relevant order updates
                if (order.X === 'FILLED') {
                     addLog(`Trade event: Order ${order.i} (${order.o}, ${order.ps}) FILLED. Qty: ${order.q}, PNL: ${order.rp}, ReduceOnly: ${order.R}`);
                     processTradeResult(order); // This function logs PNL updates
                } else if (order.X === 'CANCELED') {
                    addLog(`Trade event: Order ${order.i} (${order.o}, ${order.ps}) CANCELED.`);
                     if (currentLongPosition?.currentSLId === order.i) currentLongPosition.currentSLId = null;
                     if (currentLongPosition?.currentTPId === order.i) currentLongPosition.currentTPId = null;
                     if (currentShortPosition?.currentSLId === order.i) currentShortPosition.currentSLId = null;
                     if (currentShortPosition?.currentTPId === order.i) currentShortPosition.currentTPId = null;
                 } else if (order.X === 'EXPIRED') {
                    addLog(`Trade event: Order ${order.i} (${order.o}, ${order.ps}) EXPIRED.`);
                     if (currentLongPosition?.currentSLId === order.i) currentLongPosition.currentSLId = null;
                     if (currentLongPosition?.currentTPId === order.i) currentLongPosition.currentTPId = null;
                     if (currentShortPosition?.currentSLId === order.i) currentShortPosition.currentSLId = null;
                     if (currentShortPosition?.currentTPId === order.i) currentShortPosition.currentTPId = null;
                 }
                // Ignoring 'NEW', 'PARTIALLY_FILLED', 'REJECTED' unless they cause issues
            } else if (data.e === 'ACCOUNT_UPDATE') {
                 // addLog('Account Update received.'); // Too frequent log
            } else if (data.e === 'listenKeyExpired') {
                 addLog('ListenKey Expired event received.', true);
                 // keepAliveListenKey will handle this scenario too
                 keepAliveListenKey().catch(err => {
                      addLog(`Error fetching new key after expiration event: ${err.message}`, true);
                       if(err instanceof CriticalApiError) stopBotLogicInternal();
                 });
            }

        } catch (e) { addLog(`User Data WS parse error: ${e.message}`); }
    };
    userDataWs.onerror = (error) => {
        addLog(`User Data WebSocket error: ${error.message}. Reconnecting in 5s...`, true);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
        userDataWs = null; listenKey = null; // Clear key as it might be invalid
        if (botRunning) setTimeout(async () => {
             try { listenKey = await getListenKey(); setupUserDataStream(listenKey); }
             catch (e) {
                 addLog(`Reconnect UD WS Error: ${e.message}`, true);
                 if(e instanceof CriticalApiError) stopBotLogicInternal();
             }
        }, 5000);
    };
    userDataWs.onclose = (event) => {
        addLog(`User Data WebSocket closed. Code: ${event.code}, Reason: ${event.reason}. Reconnecting in 5s...`, true);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
        userDataWs = null; listenKey = null;
        if (botRunning) setTimeout(async () => {
             try { listenKey = await getListenKey(); setupUserDataStream(listenKey); }
              catch (e) {
                 addLog(`Reconnect UD WS Error: ${e.message}`, true);
                  if(e instanceof CriticalApiError) stopBotLogicInternal();
             }
        }, 5000);
    };
}


async function runTradingLogic() {
    if (!botRunning) { addLog('Bot not running. Skipping trade cycle.'); return; }

     // Initial check if positions are already active (sync with Binance state)
    try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

         if (positionsOnBinance.length > 0 || currentLongPosition || currentShortPosition) {
            addLog(`Trade cycle check: Active positions found. Switching to monitoring mode.`);
            // This should trigger scheduleNextMainCycle which ensures interval is running
            scheduleNextMainCycle();
            return;
        }
    } catch (error) {
         addLog(`Error checking positions before opening in trade cycle: ${error.message}`, true);
         if(error instanceof CriticalApiError) { stopBotLogicInternal(); } // Critical API error stops bot
         else { // Non-critical, retry this trade cycle check after a delay
            addLog(`Retrying trade cycle check in 5 seconds.`);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 5000); // Reschedule self
         }
         return; // Exit current attempt
    }

     addLog('Starting new trade cycle: Opening both LONG and SHORT positions.');

    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        let usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`Available USDT: ${usdtAsset.toFixed(2)}`);

        const minimumRequiredCapital = INITIAL_INVESTMENT_AMOUNT * 2 * 1.1; // Cap * 2 + ~10% buffer for fees/margin fluctuations
        if (usdtAsset < minimumRequiredCapital) {
            addLog(`Insufficient USDT balance (${usdtAsset.toFixed(2)}). Need approx ${minimumRequiredCapital.toFixed(2)}. Skipping trade cycle.`, true);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000); // Wait 10 seconds before re-checking balance
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog(`Failed to get leverage for ${TARGET_COIN_SYMBOL}. Skipping trade cycle.`, true);
             nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000);
            return;
        }

        // Open LONG position
        addLog(`Opening LONG position for ${TARGET_COIN_SYMBOL}.`);
        const longPosAttempt = await openPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!longPosAttempt) {
            addLog('Failed to open LONG position. Skipping trade cycle.');
             nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000);
            return;
        }
        currentLongPosition = longPosAttempt; // Update state
        await sleep(2000); // Delay between orders

        // Get latest balance after opening LONG
         try {
             const accountAfterLong = await callSignedAPI('/fapi/v2/account', 'GET');
             usdtAsset = parseFloat(accountAfterLong.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
            // addLog(`Available USDT after opening LONG: ${usdtAsset.toFixed(2)}`); // Reduces spam
         } catch (balError) {
             addLog(`Error getting balance after LONG open: ${balError.message}. Using previous estimate.`, true);
         }


        // Open SHORT position
        addLog(`Opening SHORT position for ${TARGET_COIN_SYMBOL}.`);
        const shortPosAttempt = await openPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!shortPosAttempt) {
            addLog('Failed to open SHORT position. Attempting to close LONG position if open.', true);
            if (currentLongPosition) { // Check if LONG position was successfully tracked locally
                 closePosition(TARGET_COIN_SYMBOL, currentLongPosition.quantity, 'Failed to open SHORT leg', 'LONG').catch(err => {
                    addLog(`Error closing LONG after SHORT failure: ${err.message}`, true);
                    if(err instanceof CriticalApiError) stopBotLogicInternal();
                 });
                currentLongPosition = null; // Reset local state immediately
            }
             nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000);
            return;
        }
         currentShortPosition = shortPosAttempt; // Update state

        addLog(`Successfully opened both positions for ${TARGET_COIN_SYMBOL}.`);

        // Schedule initial TP/SL placement and verification
        scheduleInitialTPAndSLPlacement();

        // Now that positions are open, switch to monitoring mode managed by the interval
        scheduleNextMainCycle(); // This call will detect current positions and start the interval

    } catch (error) {
        addLog(`Error during main trade cycle (runTradingLogic): ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        else { // Non-critical errors during opening, wait 10s and retry the cycle
            addLog(`Retrying main trade cycle in 10 seconds after error.`);
             nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000);
        }
    }
}


// Called by processTradeResult when final closing trade is detected
async function cleanupAndResetCycle_Internal(symbol) {
    if (!botRunning) { addLog("Bot not running, skipping cleanup.", true); return; }
    addLog(`Cycle ended for ${symbol}. Performing cleanup.`, true);

    // Double-check Binance state to be sure positions are 0 quantity
     try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positionsOnBinanceRaw.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remainingPositions.length > 0) {
             addLog(`Cleanup: Found ${remainingPositions.length} remaining positions on Binance for ${symbol}. Attempting to force close them.`, true);
             // Call checkAndHandleRemainingPosition which forces market close and then recursively calls this cleanup function IF they are successfully closed.
             checkAndHandleRemainingPosition(symbol).catch(err => {
                  addLog(`Error during checkAndHandleRemainingPosition during cleanup: ${err.message}`, true);
                 if (err instanceof CriticalApiError) stopBotLogicInternal();
             });
             return; // Exit this cleanup call, it will be re-triggered if needed
        } else {
            addLog(`Cleanup: No remaining positions on Binance for ${symbol}.`, true);
        }
     } catch (error) {
         addLog(`Cleanup: Error checking remaining positions on Binance: ${error.message}`, true);
          if (error instanceof CriticalApiError) { stopBotLogicInternal(); return;} // Critical error stops bot
         // Continue cleanup process despite non-critical error
     }


    // Cancel all open orders for the symbol
     addLog(`Cleanup: Canceling all open orders for ${symbol}.`);
    try {
        await cancelOpenOrdersForSymbol(symbol, null, 'BOTH');
         addLog(`Cleanup: Finished canceling open orders.`);
    } catch (error) {
        addLog(`Cleanup: Error cancelling orders: ${error.msg || error.message}`, true);
         // Non-critical error can be ignored
    }

    // Reset local state variables for positions
    currentLongPosition = null;
    currentShortPosition = null;

    // Stop the position check interval
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        addLog('Cleanup: Position monitor interval stopped.');
    }

    // Schedule the next main cycle (which will check status and start runTradingLogic if no positions)
    if (botRunning) {
        addLog(`Cleanup complete. Bot running, scheduling next cycle.`);
        scheduleNextMainCycle();
    } else {
        addLog(`Cleanup complete. Bot not running.`);
    }
}


// Function wrapper for checkAndHandleRemainingPosition primarily for clarity or external calls
async function checkAndHandleRemainingPosition(symbol) {
     if (!botRunning) return;
     await cleanupAndResetCycle_Internal(symbol);
}


const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, customLogData) => {
        if (!err && customLogData && customLogData.trim().length > 0) {
             const lines = customLogData.split('\n');
            const maxDisplayLines = 500;
            const startIndex = Math.max(0, lines.length - maxDisplayLines);
            const limitedLogs = lines.slice(startIndex).join('\n');
            res.send(limitedLogs);
        } else {
            fs.readFile(BOT_LOG_FILE, 'utf8', (err, pm2LogData) => {
                if (err) { console.error('Error reading log file:', err); return res.status(404).send(`Log file not found: ${BOT_LOG_FILE}`); }
                const cleanData = pm2LogData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
                const lines = cleanData.split('\n');
                const maxDisplayLines = 500;
                const startIndex = Math.max(0, lines.length - maxDisplayLines);
                const limitedLogs = lines.slice(startIndex).join('\n');
                res.send(limitedLogs);
            });
        }
    });
});

app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => {
            exec('pm2 jlist', (error, stdout, stderr) => {
                if (error) return reject(stderr || error.message);
                try { resolve(JSON.parse(stdout)); } catch(e) { reject('Failed to parse PM2 list JSON'); }
            });
        });
        const botProcess = pm2List.find(p => p.name === THIS_BOT_PM2_NAME);

        let statusResponse = {
             pm2Status: 'OFFLINE / NOT FOUND',
             internalBotStatus: 'UNKNOWN',
             configuredSymbol: TARGET_COIN_SYMBOL,
             configuredInitialCapital: INITIAL_INVESTMENT_AMOUNT,
             uptimeMinutes: 0,
             restartCount: 0,
             openPositions: { long: false, short: false },
             liveStatus: "N/A" // Indicates if detailed bot internal state is reliable
        };

        if (botProcess) {
             statusResponse.pm2Status = botProcess.pm2_env.status.toUpperCase();
             statusResponse.restartCount = botProcess.pm2_env.restart_time;
             if (botProcess.pm2_env.pm_uptime) {
                 statusResponse.uptimeMinutes = Math.floor((Date.now() - botProcess.pm2_env.pm_uptime) / (1000 * 60));
             }

            if (botProcess.pm2_env.status === 'online' && botRunning) {
                 statusResponse.internalBotStatus = 'RUNNING';
                 statusResponse.openPositions.long = !!currentLongPosition;
                 statusResponse.openPositions.short = !!currentShortPosition;
                 if (botStartTime) statusResponse.uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / (1000 * 60));
                 statusResponse.liveStatus = `OK | WS: MKT=${marketWs?'ON':'OFF'}, UD=${userDataWs?'ON':'OFF'} | Err:${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}`;

             } else if (botProcess.pm2_env.status === 'online' && !botRunning) {
                 statusResponse.internalBotStatus = 'STOPPED_INTERNALLY';
                  statusResponse.liveStatus = `STOPPED | Check logs`;
             } else {
                 statusResponse.internalBotStatus = 'NOT_ONLINE';
                  statusResponse.liveStatus = `PM2 STATUS: ${statusResponse.pm2Status}`;
             }
        } else {
             statusResponse.liveStatus = "PM2 process not found.";
        }

        res.json(statusResponse);

    } catch (error) {
        console.error('Error getting status:', error);
        res.status(500).json({ success: false, message: 'Error getting bot status.', error: error.message });
    }
});


app.get('/api/bot_stats', async (req, res) => {
    try {
        // Only attempt fetching live positions and PNL if bot is running internally
         const livePositionsOnBinanceRaw = botRunning ? await callSignedAPI('/fapi/v2/positionRisk', 'GET').catch(err => {
             addLog(`Error fetching live positions for stats: ${err.message}`, true);
             if(err instanceof CriticalApiError) throw err; // Propagate critical
             return []; // Return empty array on non-critical error
         }) : [];
        const livePositionsOnBinance = livePositionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);


        let openPositionsData = [];
        // Build data using local state, updating with live data where available/appropriate
        if (currentLongPosition) {
             const livePos = livePositionsOnBinance.find(p => p.positionSide === 'LONG');
             openPositionsData.push({
                symbol: currentLongPosition.symbol,
                side: currentLongPosition.side,
                 // Use live quantity/entry/price/pnl if available, fallback to local state
                quantity: livePos ? Math.abs(parseFloat(livePos.positionAmt)) : currentLongPosition.quantity,
                initialQuantity: currentLongPosition.initialQuantity, // Use initial from state
                entryPrice: livePos ? parseFloat(livePos.entryPrice) : currentLongPosition.entryPrice,
                currentPrice: livePos ? parseFloat(livePos.markPrice) : currentMarketPrice || currentLongPosition.currentPrice, // Prefer live Mark Price, then WS cache, then local state
                unrealizedPnl: livePos ? parseFloat(livePos.unRealizedProfit) : currentLongPosition.unrealizedPnl,
                pricePrecision: currentLongPosition.pricePrecision,

                TPId: currentLongPosition.currentTPId, // From local state
                SLId: currentLongPosition.currentSLId, // From local state
                 initialTPPrice: currentLongPosition.initialTPPrice, // From local state
                 initialSLPrice: currentLongPosition.initialSLPrice, // From local state
                initialMargin: currentLongPosition.initialMargin,

                 partialCloseLossLevels: currentLongPosition.partialCloseLossLevels, // From local
                nextPartialCloseLossIndex: currentLongPosition.nextPartialCloseLossIndex, // From local
                closedQuantity: currentLongPosition.closedQuantity, // From local
                partialClosePrices: currentLongPosition.partialClosePrices, // From local
                hasRemovedInitialSL: currentLongPosition.hasRemovedInitialSL, // From local
                hasAdjustedSL6thClose: currentLongPosition.hasAdjustedSL6thClose, // From local
                hasAdjustedSL8thClose: currentLongPosition.hasAdjustedSL8thClose, // From local

                 currentProfitPercentage: currentLongPosition.initialMargin > 0 ? ((livePos ? parseFloat(livePos.unRealizedProfit) : currentLongPosition.unrealizedPnl) / currentLongPosition.initialMargin) * 100 : 0
             });
        }
         if (currentShortPosition) {
             const livePos = livePositionsOnBinance.find(p => p.positionSide === 'SHORT');
             openPositionsData.push({
                 symbol: currentShortPosition.symbol,
                side: currentShortPosition.side,
                 quantity: livePos ? Math.abs(parseFloat(livePos.positionAmt)) : currentShortPosition.quantity,
                 initialQuantity: currentShortPosition.initialQuantity,
                 entryPrice: livePos ? parseFloat(livePos.entryPrice) : currentShortPosition.entryPrice,
                 currentPrice: livePos ? parseFloat(livePos.markPrice) : currentMarketPrice || currentShortPosition.currentPrice,
                 unrealizedPnl: livePos ? parseFloat(livePos.unRealizedProfit) : currentShortPosition.unrealizedPnl,
                pricePrecision: currentShortPosition.pricePrecision,

                TPId: currentShortPosition.currentTPId,
                SLId: currentShortPosition.currentSLId,
                 initialTPPrice: currentShortPosition.initialTPPrice,
                 initialSLPrice: currentShortPosition.initialSLPrice,
                initialMargin: currentShortPosition.initialMargin,

                 partialCloseLossLevels: currentShortPosition.partialCloseLossLevels,
                 nextPartialCloseLossIndex: currentShortPosition.nextPartialCloseLossIndex,
                 closedQuantity: currentShortPosition.closedQuantity,
                 partialClosePrices: currentShortPosition.partialClosePrices,
                hasRemovedInitialSL: currentShortPosition.hasRemovedInitialSL,
                hasAdjustedSL6thClose: currentShortPosition.hasAdjustedSL6thClose,
                hasAdjustedSL8thClose: currentShortPosition.hasAdjustedSL8thClose,

                 currentProfitPercentage: currentShortPosition.initialMargin > 0 ? ((livePos ? parseFloat(livePos.unRealizedProfit) : currentShortPosition.unrealizedPnl) / currentShortPosition.initialMargin) * 100 : 0
             });
         }


        res.json({
            success: true,
            data: {
                totalProfit: totalProfit, // Use bot's accumulated total
                totalLoss: totalLoss,     // Use bot's accumulated total
                netPNL: netPNL,           // Use bot's calculated net
                currentOpenPositions: openPositionsData, // Send combined live/local data
                currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT,
                 botRunning: botRunning, // Include bot's internal running state
                 targetSymbol: TARGET_COIN_SYMBOL,
            }
        });
    } catch (error) {
        console.error('Error getting bot stats:', error);
         if (error instanceof CriticalApiError) { addLog(`Critical API error getting stats: ${error.message}`, true); }
        res.status(500).json({ success: false, message: 'Error getting bot stats.', error: error.message || 'Unknown error' });
    }
});


app.post('/api/configure', (req, res) => {
    const { coinConfigs } = req.body;

     if (!coinConfigs || !Array.isArray(coinConfigs) || coinConfigs.length === 0 || !coinConfigs[0] || typeof coinConfigs[0].symbol !== 'string' || typeof coinConfigs[0].initialAmount === 'undefined') {
         const msg = "Invalid or missing configuration data.";
         addLog(msg, true);
        return res.status(400).json({ success: false, message: msg });
     }

     if (botRunning) {
         const msg = 'Stop the bot before re-configuring.';
         addLog(`Config attempt denied: Bot is running. ${msg}`, true);
        return res.status(409).json({ success: false, message: msg });
     }

    const config = coinConfigs[0];
    const oldTargetCoinSymbol = TARGET_COIN_SYMBOL;

     const newTargetCoinSymbol = config.symbol.trim().toUpperCase();
     // Optional: Add more robust symbol validation vs exchangeInfo?
     // if (!/^[A-Z]+USDT$/.test(newTargetCoinSymbol)) { // Example simple validation
     //    const msg = `Invalid symbol format: ${newTargetCoinSymbol} (expected like BTCUSDT).`; addLog(msg, true);
     //    return res.status(400).json({ success: false, message: msg });
     // }


    const newInitialAmount = parseFloat(config.initialAmount);
     if (isNaN(newInitialAmount) || newInitialAmount <= 0) {
        const msg = `Invalid initial amount: ${config.initialAmount}. Must be a positive number.`;
         addLog(msg, true);
        return res.status(400).json({ success: false, message: msg });
     }


    // Update config variables
    TARGET_COIN_SYMBOL = newTargetCoinSymbol;
    INITIAL_INVESTMENT_AMOUNT = newInitialAmount;


    // If symbol changed, reset internal state
    if (oldTargetCoinSymbol !== TARGET_COIN_SYMBOL) {
        addLog(`Target symbol changed from ${oldTargetCoinSymbol} to ${TARGET_COIN_SYMBOL}. Resetting trade state.`, true);
        // Ensure state is reset to sync properly on next start
        currentLongPosition = null;
        currentShortPosition = null;
        totalProfit = 0;
        totalLoss = 0;
        netPNL = 0;
        exchangeInfoCache = null; // Clear cache for the old symbol
         isClosingPosition = false; // Reset flag
         // WebSockets are reset in stopBotLogicInternal if running. On next start they use new symbol.
    } else {
         addLog(`Config updated for current symbol ${TARGET_COIN_SYMBOL}.`, true);
    }

    addLog(`Configuration updated successfully. Symbol: ${TARGET_COIN_SYMBOL}, Capital per leg: ${INITIAL_INVESTMENT_AMOUNT} USDT. Restart bot to apply.`);

    res.json({ success: true, message: 'Configuration updated.' });
});

app.get('/start_bot_logic', async (req, res) => {
     let message = 'Processing start request...';
    try {
        message = await startBotLogicInternal();
         // Report success/failure based on the returned message
         if(botRunning){
             res.json({ success: true, message: message, botRunning: true });
         } else {
            // If botRunning is false after internal start, it means start failed (handled inside)
             res.json({ success: false, message: message, botRunning: false });
         }

    } catch (error) {
        // This catch should ideally only be for unexpected errors *outside* startBotLogicInternal's handling
        console.error('Unexpected error calling startBotLogicInternal:', error);
        addLog(`Unexpected error during bot start: ${error.message}`, true);
        // stopBotLogicInternal() already attempts recovery schedule if it's a CriticalAPIError
        res.status(500).json({ success: false, message: `An unexpected error occurred during start: ${error.message}`, botRunning: botRunning });
    }
});

app.get('/stop_bot_logic', (req, res) => {
     let message = 'Processing stop request...';
    try {
        message = stopBotLogicInternal();
        res.json({ success: !botRunning, message: message, botRunning: botRunning });

    } catch (error) {
        console.error('Error calling stopBotLogicInternal:', error);
         addLog(`Error during bot stop: ${error.message}`, true);
         res.status(500).json({ success: false, message: `Error stopping bot: ${error.message}`, botRunning: botRunning });
    }
});


app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server listening on port ${WEB_SERVER_PORT}`, true);
});

 
