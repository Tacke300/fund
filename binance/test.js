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
                logCounts[messageHash].lastLoggedTime = now;
                return;
            }
             logCounts[messageHash] = { count: 1, lastLoggedTime: now };
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
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
        hour12: false, timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else {
                    let errorDetails = { code: res.statusCode, msg: `HTTP Error: ${res.statusCode} ${res.statusMessage}` };
                    try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; } catch (e) {}
                    reject(errorDetails);
                }
            });
        });
        req.on('error', e => reject({ code: 'NETWORK_ERROR', msg: e.message }));
        if (method === 'POST' || method === 'PUT') req.write(postData);
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Missing API_KEY or SECRET_KEY. Check config.js.");
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath, requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };

    if (method === 'GET' || method === 'DELETE') { requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/json'; }
    else if (method === 'POST' || method === 'PUT') { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else throw new Error(`Method not supported: ${method}`);

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`API error (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`, true);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Critical API error, bot stopping.");
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
        addLog(`Public API error (GET ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`, true);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Critical API error, bot stopping.");
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
        if (response?.[0]?.brackets?.[0]) {
             return parseInt(response[0].brackets[0].maxInitialLeverage || response[0].brackets[0].initialLeverage);
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
        return false;
    }
}

async function getExchangeInfo() {
    if (exchangeInfoCache) return exchangeInfoCache;
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSize = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSize = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const minNotional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceF = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                minQty: lotSize ? parseFloat(lotSize.minQty) : (marketLotSize ? parseFloat(marketLotSize.minQty) : 0),
                stepSize: lotSize ? parseFloat(lotSize.stepSize) : (marketLotSize ? parseFloat(marketLotSize.minQty) : 0.001),
                minNotional: minNotional ? parseFloat(minNotional.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceF ? parseFloat(priceF.tickSize) : 0.001
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
    } catch (error) { return null; }
}

async function cancelOpenOrdersForSymbol(symbol, orderId = null, positionSide = null) {
    try {
        let params = { symbol };
        if (orderId) params.orderId = orderId;
        if (positionSide && positionSide !== 'BOTH') params.positionSide = positionSide;
        await callSignedAPI(orderId ? '/fapi/v1/order' : '/fapi/v1/allOpenOrders', 'DELETE', params);
    } catch (error) {
        if (error.code !== -2011) addLog(`Error canceling order(s) for ${symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnl, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;
    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED' || parseFloat(realizedPnl) === 0) return;

    if (parseFloat(realizedPnl) > 0) totalProfit += parseFloat(realizedPnl);
    else totalLoss += Math.abs(parseFloat(realizedPnl));
    netPNL = totalProfit - totalLoss;

    addLog(`Trade Closed: ${positionSide} ${symbol} | PNL: ${parseFloat(realizedPnl).toFixed(2)} USDT | Total PNL: ${netPNL.toFixed(2)}`, true);

    let isBotMainClosure = false;
    if (currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId)) {
         isBotMainClosure = true;
     } else if (currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId)) {
         isBotMainClosure = true;
     }

    if (isBotMainClosure) {
        addLog(`Main TP/SL triggered for ${positionSide}. Attempting to close the other position.`, true);
        let otherPosition = (positionSide === 'LONG' && currentShortPosition) ? currentShortPosition : (positionSide === 'SHORT' && currentLongPosition) ? currentLongPosition : null;

        if (otherPosition) {
             // Clear local state for the leg that just closed TP/SL
             if(positionSide === 'LONG') currentLongPosition = null;
             else currentShortPosition = null;
             // Close the opposing leg
             closePosition(TARGET_COIN_SYMBOL, otherPosition.quantity, `Opposite leg ${positionSide} filled TP/SL`, otherPosition.side)
             .catch(err => {
                  addLog(`Error closing other position after main TP/SL: ${err.message}`, true);
                  if(err instanceof CriticalApiError) stopBotLogicInternal();
              });
             // Cleanup is triggered when the market close order for the other position reports FILLED via WS.
        } else {
            addLog("No opposing position found to close or it's already gone. Proceeding with cleanup.", true);
            if(positionSide === 'LONG') currentLongPosition = null; // Ensure local state reset
            else currentShortPosition = null;
             // If no other position, cleanup now
             cleanupAndResetCycle_Internal(TARGET_COIN_SYMBOL)
             .catch(err => {
                 addLog(`Error during cleanup after single leg close: ${err.message}`, true);
                  if(err instanceof CriticalApiError) stopBotLogicInternal();
              });
        }
    }
}

async function closePosition(symbol, quantity, reason, positionSide) {
    if (!symbol || !positionSide || !botRunning || isClosingPosition || (positionSide === 'LONG' && !currentLongPosition) || (positionSide === 'SHORT' && !currentShortPosition)) {
        return;
    }
    isClosingPosition = true;
    addLog(`Closing ${positionSide} position for ${symbol} (Reason: ${reason}).`);
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Symbol info for ${symbol} unavailable. Cannot close.`, true);
            return;
        }
        const quantityPrecision = symbolInfo.quantityPrecision;

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} (${positionSide}) already closed on Binance. Reason: ${reason}.`, true);
             // Update local state as well if it somehow wasn't reset by trade stream
             if(positionSide === 'LONG' && currentLongPosition) currentLongPosition = null;
             if(positionSide === 'SHORT' && currentShortPosition) currentShortPosition = null;
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
             if (actualQuantityToClose <= 0) return; // Safety check, should be covered by above
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';

             await cancelOpenOrdersForSymbol(symbol, null, positionSide);
            await sleep(200);

            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: adjustedActualQuantity, reduceOnly: true });
            addLog(`Market close order sent for ${symbol} (${positionSide}).`, true);
        }
    } catch (error) {
        addLog(`Error closing position ${symbol} (${positionSide}): ${error.msg || error.message}`, true);
         if (error instanceof CriticalApiError) stopBotLogicInternal();
    } finally {
        isClosingPosition = false;
    }
}

async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (symbol !== TARGET_COIN_SYMBOL || !botRunning || (tradeDirection === 'LONG' && currentLongPosition) || (tradeDirection === 'SHORT' && currentShortPosition)) {
        return null;
    }

    addLog(`Opening ${tradeDirection} position for ${symbol}. Capital: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) { addLog(`Symbol info for ${symbol} unavailable. Cannot open.`, true); return null; }
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) { addLog(`Failed to set leverage. Cannot open.`, true); return null; }
        await sleep(500);

        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) { addLog(`Failed to get current price. Cannot open.`, true); return null; }

        const capitalToUse = INITIAL_INVESTMENT_AMOUNT;
        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity <= 0 || quantity * currentPrice < minNotional) { addLog(`Calculated quantity ${quantity} is too small. Cannot open.`, true); return null; }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        addLog(`Sending MARKET order to open ${tradeDirection} for ${symbol}. Qty: ${quantity.toFixed(quantityPrecision)}.`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity, newOrderRespType: 'FULL' });

        await sleep(1000);

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) { addLog(`Position not found on Binance after opening MARKET order for ${tradeDirection} ${symbol}.`, true); return null; }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt));
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now()));

        addLog(`Successfully opened ${tradeDirection} position for ${symbol}.`, true);
        addLog(`-> Qty: ${actualQuantity.toFixed(quantityPrecision)}, Entry: ${entryPrice.toFixed(pricePrecision)}`, true);

        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
        if (maxLeverage >= 75) { TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); }
        else if (maxLeverage === 50) { TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); }
        else if (maxLeverage <= 25) { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); }
        else { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 1.75; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 350); }

        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_MULTIPLIER;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_MULTIPLIER;
        const priceChangeForTP = actualQuantity > 0 ? profitTargetUSDT / actualQuantity : 0;
        const priceChangeForSL = actualQuantity > 0 ? lossLimitUSDT / actualQuantity : 0;

        let initialCalculatedSLPrice, initialCalculatedTPPrice;
        if (tradeDirection === 'LONG') {
             initialCalculatedSLPrice = Math.floor((entryPrice - priceChangeForSL) / tickSize) * tickSize;
             initialCalculatedTPPrice = Math.floor((entryPrice + priceChangeForTP) / tickSize) * tickSize;
        } else {
             initialCalculatedSLPrice = Math.ceil((entryPrice + priceChangeForSL) / tickSize) * tickSize;
             initialCalculatedTPPrice = Math.ceil((entryPrice - priceChangeForTP) / tickSize) * tickSize;
        }
         initialCalculatedSLPrice = parseFloat(initialCalculatedSLPrice.toFixed(pricePrecision));
         initialCalculatedTPPrice = parseFloat(initialCalculatedTPPrice.toFixed(pricePrecision));

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice, initialMargin: capitalToUse,
            openTime, pricePrecision, side: tradeDirection, currentPrice, unrealizedPnl: 0,
            currentTPId: null, currentSLId: null, initialTPPrice: initialCalculatedTPPrice, initialSLPrice: initialCalculatedSLPrice,
            partialCloseLossLevels: partialCloseLossSteps, nextPartialCloseLossIndex: 0,
            closedQuantity: 0, partialClosePrices: [], hasRemovedInitialSL: (tradeDirection === 'LONG' && maxLeverage >= 75),
            hasAdjustedSL6thClose: false, hasAdjustedSL8thClose: false, maxLeverageUsed: maxLeverage,
        };

    } catch (error) {
        addLog(`Error opening ${tradeDirection} position for ${symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
        await sleep(5000);
        return null;
    }
}

async function placeInitialTPAndSL(position) {
    if (!position || !botRunning) return;
    addLog(`Attempting to place initial TP/SL for ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) { addLog(`Symbol details unavailable for ${position.symbol}.`, true); return; }

        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) { addLog(`${position.side} position not found on Binance during initial TP/SL place.`, true); return; }
        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        if (actualQuantity <= 0) return;

        const { pricePrecision } = symbolDetails;
        const slPrice = position.initialSLPrice;
        const tpPrice = position.initialTPPrice;
        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';

        let placedSLOrderId = null;
        try {
            if (position.side === 'LONG' && position.maxLeverageUsed >= 75) {
                 addLog(`Skipping initial SL placement for high leverage LONG.`, true);
                 position.hasRemovedInitialSL = true;
            } else {
                 addLog(`Placing initial SL @ ${slPrice.toFixed(pricePrecision)}.`);
                 const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: slPrice, closePosition: 'true', newOrderRespType: 'FULL' });
                 placedSLOrderId = slOrderResult.orderId; position.currentSLId = placedSLOrderId; position.hasRemovedInitialSL = false;
                 addLog(`Initial SL placed. OrderId: ${placedSLOrderId}`);
            }
        } catch (slError) {
             addLog(`Failed to place initial SL: ${slError.msg || slError.message}`, true);
             position.currentSLId = null; if (slError.code === -2021 || (slError.msg?.includes('immediately trigger'))) addLog(`SL immediately triggered on placement.`, true);
             if (slError instanceof CriticalApiError) throw slError;
        }
        await sleep(200);

        let placedTPOrderId = null;
        try {
             addLog(`Placing initial TP @ ${tpPrice.toFixed(pricePrecision)}.`);
             const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: tpPrice, closePosition: 'true', newOrderRespType: 'FULL' });
             placedTPOrderId = tpOrderResult.orderId; position.currentTPId = placedTPOrderId;
             addLog(`Initial TP placed. OrderId: ${placedTPOrderId}`);
        } catch (tpError) {
             addLog(`Failed to place initial TP: ${tpError.msg || tpError.message}`, true);
             position.currentTPId = null; if (tpError.code === -2021 || (tpError.msg?.includes('immediately trigger'))) addLog(`TP immediately triggered on placement.`, true);
             if (tpError instanceof CriticalApiError) throw tpError;
        }
        await sleep(200);

    } catch (error) {
        addLog(`Error in placeInitialTPAndSL for ${position.side} ${position.symbol}: ${error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function checkAndRecreateMissingTPAndSL(position) {
    if (!position || !botRunning) return;
    addLog(`Checking for missing initial TP/SL for ${position.side} ${position.symbol}...`);

    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: position.symbol });
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
        if (!currentPosOnBinance) { addLog(`${position.side} position not found on Binance during re-check. Skip.`, true); return; }

        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        const shouldHaveSL = !(position.side === 'LONG' && position.maxLeverageUsed >= 75);

        const hasActiveTP = position.currentTPId ? openOrders.some(o => o.orderId === position.currentTPId && o.status === 'NEW') : false;
        const hasActiveSL = position.currentSLId ? openOrders.some(o => o.orderId === position.currentSLId && o.status === 'NEW') : false;

        if (!hasActiveTP) {
            addLog(`TP missing for ${position.side} ${position.symbol}. Recreating...`);
             await placeInitialTPAndSL(position); // Reuse placement logic
        }

        if (!hasActiveSL && shouldHaveSL) {
            addLog(`SL missing for ${position.side} ${position.symbol}. Recreating...`);
            await placeInitialTPAndSL(position); // Reuse placement logic
        }

    } catch (error) {
        addLog(`Error checking/recreating TP/SL for ${position.side} ${position.symbol}: ${error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}


async function scheduleInitialTPAndSLPlacement() {
    if (!botRunning || !currentLongPosition || !currentShortPosition) return;

    addLog(`Scheduling initial TP/SL placement in 5 seconds.`);
    setTimeout(async () => {
        if (!botRunning) return;
        try {
             addLog(`Attempting initial TP/SL placement (scheduled).`);
            if (currentLongPosition) await placeInitialTPAndSL(currentLongPosition);
            if (currentShortPosition) await placeInitialTPAndSL(currentShortPosition);

            if (botRunning && (currentLongPosition || currentShortPosition)) {
                addLog(`Scheduling missing TP/SL check in 20 seconds.`);
                setTimeout(async () => {
                    if (!botRunning) return;
                     addLog(`Attempting re-check/re-creation of missing initial TP/SL (scheduled).`);
                    if (currentLongPosition) await checkAndRecreateMissingTPAndSL(currentLongPosition);
                    if (currentShortPosition) await checkAndRecreateMissingTPAndSL(currentShortPosition);
                }, 20000);
            }
        } catch (error) {
            addLog(`Error during initial TP/SL scheduling attempt: ${error.message}`, true);
             if (error instanceof CriticalApiError) stopBotLogicInternal();
        }
    }, 5000);
}

async function addPosition(position, quantityToReopen, reason) {
    if (!position || quantityToReopen <= 0 || !botRunning) return;

    const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
    const currentPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);
    if (!currentPositionOnBinance) {
        addLog(`${position.side} position for ${position.symbol} not found. Cannot add.`, true);
        if(position.side === 'LONG') currentLongPosition = null;
        else currentShortPosition = null;
        return;
    }

    addLog(`Adding ${quantityToReopen.toFixed(position.quantityPrecision)} quantity to ${position.side} position for ${position.symbol} (Reason: ${reason}).`);
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) { addLog(`Symbol details for ${position.symbol} unavailable. Cannot add.`, true); return; }

        const currentPrice = await getCurrentPrice(position.symbol);
        if (!currentPrice) { addLog(`Current price for ${position.symbol} unavailable. Cannot add.`, true); return; }

        const { quantityPrecision, minNotional, stepSize } = symbolDetails;
        let adjustedQuantityToReopen = Math.floor(quantityToReopen / stepSize) * stepSize;
        adjustedQuantityToReopen = parseFloat(adjustedQuantityToReopen.toFixed(quantityPrecision));

        if (adjustedQuantityToReopen <= 0 || adjustedQuantityToReopen * currentPrice < minNotional) { addLog(`Adjusted quantity ${adjustedQuantityToReopen} or notional too small. Cannot add.`, true); return; }

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSide, positionSide: position.side, type: 'MARKET', quantity: adjustedQuantityToReopen, newOrderRespType: 'FULL' });

        addLog(`Add position order sent for ${position.side} ${position.symbol}.`);
        await sleep(1000);

        addLog(`Resetting partial close/SL state and re-placing TP/SL for both legs after addPosition.`);
         [currentLongPosition, currentShortPosition].forEach(p => {
            if (p) {
                 p.nextPartialCloseLossIndex = 0; p.closedQuantity = 0; p.partialClosePrices = []; p.hasAdjustedSL6thClose = false; p.hasAdjustedSL8thClose = false;
            }
         });

        if (currentLongPosition) await recalculateAndPlaceTPAndSL(currentLongPosition);
        if (currentShortPosition) await recalculateAndPlaceTPAndSL(currentShortPosition);

    } catch (error) {
        addLog(`Error adding position to ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function recalculateAndPlaceTPAndSL(position) {
    if (!position || !botRunning) return;
    addLog(`Recalculating & Replacing TP/SL for ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) { addLog(`Symbol details for ${position.symbol} unavailable.`, true); return; }

        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
        if (!currentPosOnBinance) { addLog(`${position.side} position not found on Binance during recalc/place.`, true); return; }
        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);
        const { pricePrecision, tickSize } = symbolDetails;
         if (actualQuantity <= 0) return;

        const CAPITAL_BASE_FOR_TP_SL = INITIAL_INVESTMENT_AMOUNT;
        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER;
        if (position.maxLeverageUsed >= 75) { TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; }
        else if (position.maxLeverageUsed === 50) { TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; }
        else if (position.maxLeverageUsed <= 25) { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; }
        else { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 1.75; }

        const profitTargetUSDT = CAPITAL_BASE_FOR_TP_SL * TAKE_PROFIT_MULTIPLIER;
        const lossLimitUSDT = CAPITAL_BASE_FOR_TP_SL * STOP_LOSS_MULTIPLIER;
        const priceChangeForTP = actualQuantity > 0 ? profitTargetUSDT / actualQuantity : 0;
        const priceChangeForSL = actualQuantity > 0 ? lossLimitUSDT / actualQuantity : 0;

        let newSLPrice, newTPPrice;
         if (position.side === 'LONG') {
            newSLPrice = Math.floor((actualEntryPrice - priceChangeForSL) / tickSize) * tickSize;
            newTPPrice = Math.floor((actualEntryPrice + priceChangeForTP) / tickSize) * tickSize;
         } else {
             newSLPrice = Math.ceil((actualEntryPrice + priceChangeForSL) / tickSize) * tickSize;
             newTPPrice = Math.ceil((actualEntryPrice - priceChangeForTP) / tickSize) * tickSize;
         }
        newSLPrice = parseFloat(newSLPrice.toFixed(pricePrecision));
        newTPPrice = parseFloat(newTPPrice.toFixed(pricePrecision));


        await cancelOpenOrdersForSymbol(position.symbol, null, position.side);
        await sleep(500);

        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';

         let finalSLPriceForOrder = newSLPrice; // Default to recalculated price

         // Apply level-based SL overrides for the winning leg if conditions met
         let winningPosLocal = (currentLongPosition && currentShortPosition && currentLongPosition.unrealizedPnl > 0) ? currentLongPosition : (currentLongPosition && currentShortPosition && currentShortPosition.unrealizedPnl > 0) ? currentShortPosition : null;
         let losingPosLocal = (currentLongPosition && currentShortPosition && currentLongPosition.unrealizedPnl < 0) ? currentLongPosition : (currentLongPosition && currentShortPosition && currentShortPosition.unrealizedPnl < 0) ? currentShortPosition : null;

         if (winningPosLocal && losingPosLocal) {
             if (winningPosLocal.partialClosePrices.length >= 2 && winningPosLocal.hasAdjustedSL6thClose) finalSLPriceForOrder = losingPosLocal.partialClosePrices[1];
             if (winningPosLocal.partialClosePrices.length >= 5 && winningPosLocal.hasAdjustedSL8thClose && position.side === winningPosLocal.side) finalSLPriceForOrder = losingPosLocal.partialClosePrices[4];
         }

        let placedSLOrderId = null;
        try {
             const isSLInvalid = (position.side === 'LONG' && finalSLPriceForOrder >= actualEntryPrice) || (position.side === 'SHORT' && finalSLPriceForOrder <= actualEntryPrice);
             if (isSLInvalid) { addLog(`Calculated/Adjusted SL price (${finalSLPriceForOrder}) invalid for ${position.side}. Skipping placement.`, true); position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;}
            else {
                 addLog(`Placing SL @ ${finalSLPriceForOrder.toFixed(pricePrecision)}.`);
                const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: finalSLPriceForOrder, closePosition: 'true', newOrderRespType: 'FULL' });
                placedSLOrderId = slOrderResult.orderId; position.currentSLId = placedSLOrderId; position.initialSLPrice = finalSLPriceForOrder; position.hasRemovedInitialSL = false;
                addLog(`SL placed. OrderId: ${placedSLOrderId}`);
            }
        } catch (slError) {
             addLog(`Failed to place SL: ${slError.msg || slError.message}`, true); position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;
             if (slError instanceof CriticalApiError) throw slError;
        }
        await sleep(200);

        let placedTPOrderId = null;
        try {
            const isTPInvalid = (position.side === 'LONG' && newTPPrice <= actualEntryPrice) || (position.side === 'SHORT' && newTPPrice >= actualEntryPrice);
             if (isTPInvalid) { addLog(`Calculated TP price (${newTPPrice}) invalid for ${position.side}. Skipping placement.`, true); position.currentTPId = null; position.initialTPPrice = 0;}
             else {
                 addLog(`Placing TP @ ${newTPPrice.toFixed(pricePrecision)}.`);
                const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: newTPPrice, closePosition: 'true', newOrderRespType: 'FULL' });
                placedTPOrderId = tpOrderResult.orderId; position.currentTPId = placedTPOrderId; position.initialTPPrice = newTPPrice;
                 addLog(`TP placed. OrderId: ${placedTPOrderId}`);
             }
        } catch (tpError) {
             addLog(`Failed to place TP: ${tpError.msg || tpError.message}`, true); position.currentTPId = null; position.initialTPPrice = 0;
             if (tpError instanceof CriticalApiError) throw tpError;
        }
        await sleep(200);

    } catch (error) {
        addLog(`Error in recalculateAndPlaceTPAndSL for ${position.side} ${position.symbol}: ${error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function updateStopLoss(position, targetSLPrice) {
    if (!position || !botRunning) return;
    addLog(`Updating SL for ${position.side} ${position.symbol}${targetSLPrice !== null ? ` to ${targetSLPrice.toFixed(position.pricePrecision)}` : ''}.`);

    try {
         if (position.currentSLId) {
             addLog(`Cancelling existing SL order ${position.currentSLId}.`);
             await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side);
             position.currentSLId = null; // Update local state
         } else {
             //addLog(`No existing SL order found to cancel for ${position.side} ${position.symbol}.`); // Reduces spam
         }
         await sleep(300);

        let isCurrentPosWinning = false;
         if (currentLongPosition?.symbol === position.symbol && currentLongPosition.unrealizedPnl > 0) isCurrentPosWinning = true;
         if (currentShortPosition?.symbol === position.symbol && currentShortPosition.unrealizedPnl > 0) isCurrentPosWinning = true;

        if (targetSLPrice === null) { // Explicit cancellation
             if (isCurrentPosWinning && !position.hasRemovedInitialSL) position.hasRemovedInitialSL = true;
             addLog(`SL explicitly canceled for ${position.side}.`);
            position.initialSLPrice = null;
             return;
        }


        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
        if (!currentPosOnBinance) { addLog(`${position.side} position not found during SL update placement. Skipping.`, true); return; }

        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        if (actualQuantity <= 0) return; // Should be handled by position check

         const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);
         const isSLInvalid = (position.side === 'LONG' && targetSLPrice >= actualEntryPrice) || (position.side === 'SHORT' && targetSLPrice <= actualEntryPrice);
         if (isSLInvalid) {
            addLog(`Attempted SL price (${targetSLPrice}) is invalid for ${position.side}. Skipping update placement.`, true);
             position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;
             return;
         }


        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';
        const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: targetSLPrice, closePosition: 'true', newOrderRespType: 'FULL' });

        position.currentSLId = slOrderResult.orderId; position.initialSLPrice = targetSLPrice; position.hasRemovedInitialSL = false;
        addLog(`New SL placed for ${position.side} ${position.symbol}. OrderId: ${slOrderResult.orderId}.`, true);
        await sleep(200);

    } catch (error) {
        addLog(`Error updating SL for ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}


const manageOpenPosition = async () => {
    if (!botRunning || (!currentLongPosition && !currentShortPosition)) {
        if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
        if(botRunning && !currentLongPosition && !currentShortPosition) scheduleNextMainCycle();
        return;
    }

    if (isClosingPosition) return;

    try {
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        let hasActivePositionAfterSync = false;

        // Sync LONG
        if (currentLongPosition) {
             const livePos = positionsOnBinance.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'LONG' && parseFloat(p.positionAmt) !== 0);
             if (!livePos) { addLog(`LONG position closed on Binance.`, true); currentLongPosition = null; }
             else { currentLongPosition.unrealizedPnl = parseFloat(livePos.unRealizedProfit); currentLongPosition.currentPrice = parseFloat(livePos.markPrice); currentLongPosition.quantity = Math.abs(parseFloat(livePos.positionAmt)); currentLongPosition.entryPrice = parseFloat(livePos.entryPrice); hasActivePositionAfterSync = true; }
        }
        // Sync SHORT
        if (currentShortPosition) {
             const livePos = positionsOnBinance.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) !== 0);
             if (!livePos) { addLog(`SHORT position closed on Binance.`, true); currentShortPosition = null; }
             else { currentShortPosition.unrealizedPnl = parseFloat(livePos.unRealizedProfit); currentShortPosition.currentPrice = parseFloat(livePos.markPrice); currentShortPosition.quantity = Math.abs(parseFloat(livePos.positionAmt)); currentShortPosition.entryPrice = parseFloat(livePos.entryPrice); hasActivePositionAfterSync = true; }
        }

        if (!hasActivePositionAfterSync) {
             addLog(`No active positions on Binance. Checking/Cleaning up leftovers.`, true);
             if (currentLongPosition || currentShortPosition) { addLog(`Local state mismatch, forcing reset.`, true); currentLongPosition = null; currentShortPosition = null; }
            await cleanupAndResetCycle_Internal(TARGET_COIN_SYMBOL);
            return;
        }

        if (currentLongPosition && currentShortPosition) {
            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl > 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
            else if (currentShortPosition.unrealizedPnl > 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
            else return;

            const winningSymbolDetails = await getSymbolDetails(winningPos.symbol);
            const losingSymbolDetails = await getSymbolDetails(losingPos.symbol);
            if (!winningSymbolDetails || !losingSymbolDetails) { addLog(`Symbol details unavailable for position management.`, true); return; }

            const currentProfitPercentage = winningPos.initialMargin > 0 ? (winningPos.unrealizedPnl / winningPos.initialMargin) * 100 : 0;

            // Cancel Initial SL for Winning Leg if High Leverage, Has Profit, SL is Present, Flag Not Set
             if (winningPos.side === 'LONG' && winningPos.maxLeverageUsed >= 75 && winningPos.currentSLId && !winningPos.hasRemovedInitialSL && currentProfitPercentage > 0.5) {
                 addLog(`Winning LONG ${winningPos.symbol} profit > 0.5%, canceling initial SL.`, true);
                 await updateStopLoss(winningPos, null); // updateStopLoss sets hasRemovedInitialSL = true
            }

            // Partial Close Logic for Losing Leg
            const losingPosIndex = losingPos.nextPartialCloseLossIndex;
            const nextLossCloseLevel = losingPos.partialCloseLossLevels[losingPosIndex];
            if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel && losingPosIndex < 8) {
                 let quantityToAttemptClose = losingPos.initialQuantity * 0.10;
                 quantityToAttemptClose = Math.floor(quantityToAttemptClose / losingSymbolDetails.stepSize) * losingSymbolDetails.stepSize;
                 quantityToAttemptClose = parseFloat(quantityToAttemptClose.toFixed(losingSymbolDetails.quantityPrecision));

                 const losingPosOnBinanceCurrent = positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side);
                 if (Math.abs(parseFloat(losingPosOnBinanceCurrent?.positionAmt || '0')) >= quantityToAttemptClose && quantityToAttemptClose > 0) {
                    addLog(`Winning leg reached ${nextLossCloseLevel}%. Closing 10% of losing leg ${losingPos.symbol} (Attempt ${losingPosIndex + 1}/8).`, true);
                    await closePartialPosition(losingPos, 10, 'LOSS');
                    losingPos.nextPartialCloseLossIndex++;
                    winningPos.nextPartialCloseLossIndex = losingPos.nextPartialCloseLossIndex;
                 } else if (Math.abs(parseFloat(losingPosOnBinanceCurrent?.positionAmt || '0')) > 0) {
                     addLog(`Losing leg qty insufficient (${Math.abs(parseFloat(losingPosOnBinanceCurrent?.positionAmt || '0'))}) for partial close ${losingPosIndex + 1}. Skipping.`);
                 } else {
                     addLog(`Losing leg ${losingPos.symbol} closed. Marking partial close index max.`, true);
                      if (losingPosIndex < 8) { losingPos.nextPartialCloseLossIndex = 8; winningPos.nextPartialCloseLossIndex = 8; }
                 }
             } else if (losingPosIndex >= 8 && Math.abs(parseFloat(positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')) > 0) {
                 addLog(`Attempted 8 partial closes on losing leg. Force closing remaining position.`, true);
                 await closePosition(losingPos.symbol, Math.abs(parseFloat(positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')), 'Force close after 8 partials failed', losingPos.side);
             }


             // SL Adjustment Logic (Level 6 and 8)
             const partialCloseCount = winningPos.nextPartialCloseLossIndex;

             // Level 6: Adjust SL for BOTH legs to losing leg's entry price at 2nd partial close (index 1)
             if (partialCloseCount >= 6 && !winningPos.hasAdjustedSL6thClose) {
                 if (losingPos.partialClosePrices.length >= 2) {
                     const slTargetPrice = losingPos.partialClosePrices[1];
                     addLog(`Level 6 reached. Adjusting SL of both legs to ${slTargetPrice}.`, true);
                     if (currentLongPosition) await updateStopLoss(currentLongPosition, slTargetPrice);
                     if (currentShortPosition) await updateStopLoss(currentShortPosition, slTargetPrice);
                    winningPos.hasAdjustedSL6thClose = true;
                 }
             }

             // Level 8: Adjust SL for WINNING leg ONLY to losing leg's entry price at 5th partial close (index 4)
             if (partialCloseCount >= 8 && !winningPos.hasAdjustedSL8thClose && winningPos) {
                 if (losingPos.partialClosePrices.length >= 5) {
                     const slTargetPrice = losingPos.partialClosePrices[4];
                     const remainingLosingQty = Math.abs(parseFloat(positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0'));

                    if (remainingLosingQty < (losingPos.initialQuantity * 0.01) ) { // Check if losing leg is substantially closed
                         addLog(`Level 8 reached. Losing leg closed. Adjusting SL of winning leg ${winningPos.side} to ${slTargetPrice}.`, true);
                         await updateStopLoss(winningPos, slTargetPrice);
                         winningPos.hasAdjustedSL8thClose = true;
                    } else {
                        addLog(`Level 8 reached, but losing leg still open (${remainingLosingQty}). Skipping winning leg SL adjust.`);
                    }
                 }
            }

            // Add Position Logic (profit reversion)
             if (winningPos.nextPartialCloseLossIndex > 0 && winningPos.nextPartialCloseLossIndex <= 7) {
                 const currentWinningProfitPercentage = winningPos.initialMargin > 0 ? (winningPos.unrealizedPnl / winningPos.initialMargin) * 100 : 0;
                 if (currentWinningProfitPercentage <= 0.1 && losingPos.closedQuantity > 0) {
                     addLog(`Winning leg profit returned to ${currentWinningProfitPercentage.toFixed(2)}%. Adding back ${losingPos.closedQuantity.toFixed(losingPosDetails.quantityPrecision)} to losing leg ${losingPos.symbol}.`, true);
                     await addPosition(losingPos, losingPos.closedQuantity, 'Winning leg profit reverted');
                 }
             }
        } else if (currentLongPosition || currentShortPosition) {
             // Only one position remains (after TP/SL fill etc.)
             const remainingPos = currentLongPosition || currentShortPosition;
             // Ensure its TP/SL are active, might be useful if one leg liquidates or is manually closed unexpectedly
             // Reusing checkAndRecreateMissingTPAndSL seems reasonable
            // addLog(`Only one position (${remainingPos.side}) remains. Ensuring its TP/SL.`); // Too noisy
            // await checkAndRecreateMissingTPAndSL(remainingPos); // Let schedule handle this
        }


    } catch (error) {
        addLog(`Error in manageOpenPosition: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
};

async function scheduleNextMainCycle() {
    if (!botRunning) { return; }
    clearTimeout(nextScheduledCycleTimeout);

    try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

        if (positionsOnBinance.length > 0 || currentLongPosition || currentShortPosition) {
            if (!positionCheckInterval && botRunning) {
                 positionCheckInterval = setInterval(async () => {
                    if (botRunning && (currentLongPosition || currentShortPosition)) {
                        try { await manageOpenPosition(); }
                        catch (error) {
                             addLog(`Interval error: ${error.message}`, true);
                             if (error instanceof CriticalApiError) stopBotLogicInternal();
                        }
                    } else if (!botRunning && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
                    else if ((!currentLongPosition && !currentShortPosition) && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; if(botRunning) scheduleNextMainCycle(); }
                }, 5000);
            }
        } else {
            addLog(`No active positions. Scheduling new cycle in 2 seconds.`);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
        }
    } catch (error) {
        addLog(`Error checking positions before scheduling cycle: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        else {
             nextScheduledCycleTimeout = setTimeout(scheduleNextMainCycle, 5000);
        }
    }
}

async function getListenKey() {
    if (!API_KEY || !SECRET_KEY) { addLog("API Key/Secret not configured.", true); return null; }
    try {
        const data = await callSignedAPI('/fapi/v1/listenKey', 'POST');
        return data.listenKey;
    } catch (error) { addLog(`Error fetching listenKey: ${error.msg || error.message}`, true); if (error instanceof CriticalApiError) throw error; return null; }
}

async function keepAliveListenKey() {
    if (!listenKey) {
         try { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }
         catch(e) { /* Handled by getListenKey Critical error or stream setup error */ }
        return;
    }
    try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); }
    catch (error) {
         addLog(`Error refreshing listenKey: ${error.msg || error.message}`, true);
        if (error.code === -1000 || error.code === -1125) {
            addLog(`ListenKey invalid/expired. Reconnecting.`, true);
             if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
            userDataWs?.close(); userDataWs = null; listenKey = null;
            try { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }
             catch (e) { addLog(`Reconnect UD WS Error: ${e.message}`, true); if(e instanceof CriticalApiError) throw e; }
        } else if (error instanceof CriticalApiError) throw error;
    }
}

function setupMarketDataStream(symbol) {
    if (!botRunning) { if (marketWs) marketWs.close(); marketWs = null; return; }
    if (marketWs) { marketWs.close(); marketWs = null; }
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${symbol.toLowerCase()}@markPrice@1s`;
    addLog(`Connecting Market WebSocket.`); marketWs = new WebSocket(streamUrl);
    marketWs.onopen = () => { addLog(`Market WebSocket connected.`); };
    marketWs.onmessage = (event) => {
        try { const data = JSON.parse(event.data); if (data.e === 'markPriceUpdate' && data.s === TARGET_COIN_SYMBOL.toUpperCase()) currentMarketPrice = parseFloat(data.p); }
        catch (e) { }
    };
    marketWs.onerror = (error) => {
        addLog(`Market WebSocket error: ${error.message}. Reconnecting in 5s...`, true); marketWs = null;
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); else addLog("Bot stopped. Cancel reconnect.");
    };
    marketWs.onclose = (event) => {
        addLog(`Market WebSocket closed. Code: ${event.code}. Reconnecting in 5s...`, true); marketWs = null;
        if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); else addLog("Bot stopped. Cancel reconnect.");
    };
}

function setupUserDataStream(key) {
    if (!botRunning) { if (userDataWs) userDataWs.close(); userDataWs = null; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; return; }
    if (userDataWs) { userDataWs.close(); userDataWs = null; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    if (!key) { addLog("No listenKey for User Data WebSocket.", true); return; }
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    addLog(`Connecting User Data WebSocket.`); userDataWs = new WebSocket(streamUrl);
    userDataWs.onopen = () => { addLog('User Data WebSocket connected.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 1800000); };
    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE' && data.o?.s === TARGET_COIN_SYMBOL.toUpperCase()) {
                const order = data.o;
                if (order.X === 'FILLED') {
                     addLog(`Trade event: Order ${order.i} (${order.o}, ${order.ps}) FILLED. PNL: ${order.rp}`);
                     processTradeResult(order).catch(err => addLog(`Error processing trade result: ${err.message}`, true));
                } else if (order.X === 'CANCELED' || order.X === 'EXPIRED') {
                    //addLog(`Trade event: Order ${order.i} (${order.o}, ${order.ps}) ${order.X}.`); // Too noisy
                     if (currentLongPosition?.currentSLId === order.i) currentLongPosition.currentSLId = null;
                     if (currentLongPosition?.currentTPId === order.i) currentLongPosition.currentTPId = null;
                     if (currentShortPosition?.currentSLId === order.i) currentShortPosition.currentSLId = null;
                     if (currentShortPosition?.currentTPId === order.i) currentShortPosition.currentTPId = null;
                 }
            } else if (data.e === 'listenKeyExpired') {
                 addLog('ListenKey Expired event received.', true); keepAliveListenKey().catch(err => addLog(`Error fetching new key after expiration event: ${err.message}`, true));
            }
        } catch (e) { /* addLog(`User Data WS parse error: ${e.message}`); // Reduces spam */ }
    };
    userDataWs.onerror = (error) => {
        addLog(`User Data WebSocket error: ${error.message}. Reconnecting in 5s...`, true);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
        userDataWs = null; listenKey = null;
        if (botRunning) setTimeout(async () => { try { listenKey = await getListenKey(); setupUserDataStream(listenKey); } catch (e) { addLog(`Reconnect UD WS Error: ${e.message}`, true); if(e instanceof CriticalApiError) stopBotLogicInternal(); } }, 5000);
        else addLog("Bot stopped. Cancel reconnect.");
    };
    userDataWs.onclose = (event) => {
        addLog(`User Data WebSocket closed. Code: ${event.code}. Reconnecting in 5s...`, true);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
        userDataWs = null; listenKey = null;
        if (botRunning) setTimeout(async () => { try { listenKey = await getListenKey(); setupUserDataStream(listenKey); } catch (e) { addLog(`Reconnect UD WS Error: ${e.message}`, true); if(e instanceof CriticalApiError) stopBotLogicInternal(); } }, 5000);
        else addLog("Bot stopped. Cancel reconnect.");
    };
}


async function startBotLogicInternal() {
    if (botRunning) { return 'Bot already running.'; }
    if (!API_KEY || !SECRET_KEY) { addLog('Missing API Key/Secret. Cannot start.', true); stopBotLogicInternal(); return 'Missing API Key or Secret.'; }
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; addLog('Cancelled retry schedule.'); }

    addLog('--- Starting Bot ---', true);
    try {
        await syncServerTime();
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`API Key OK! Available USDT: ${usdtAsset.toFixed(2)}.`); consecutiveApiErrors = 0;

        await getExchangeInfo();
        if (!exchangeInfoCache || !exchangeInfoCache[TARGET_COIN_SYMBOL]) { throw new CriticalApiError(`Exchange info for ${TARGET_COIN_SYMBOL} not loaded.`); }

        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);
        currentLongPosition = null; currentShortPosition = null;

        if (positionsOnBinance.length > 0) {
            addLog(`Found ${positionsOnBinance.length} open positions for ${TARGET_COIN_SYMBOL} on Binance. Attempting to restore state.`, true);
            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) throw new CriticalApiError("Failed to get leverage during resume.");

             let partialCloseSteps = [];
             if (maxLeverage >= 75) { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 100); }
             else if (maxLeverage === 50) { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 50); }
             else if (maxLeverage <= 25) { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 35); }
             else { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 350); } // Match warning log


             const openOrdersOnBinance = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: TARGET_COIN_SYMBOL });


            for (const pos of positionsOnBinance) {
                const positionSide = pos.positionSide;
                 if (pos.symbol !== TARGET_COIN_SYMBOL) continue;
                 const symbolInfo = exchangeInfoCache[TARGET_COIN_SYMBOL];
                 const pricePrecision = symbolInfo?.pricePrecision || 8;

                const recoveredPosition = {
                    symbol: TARGET_COIN_SYMBOL, quantity: Math.abs(parseFloat(pos.positionAmt)), initialQuantity: Math.abs(parseFloat(pos.positionAmt)),
                    entryPrice: parseFloat(pos.entryPrice), initialTPPrice: 0, initialSLPrice: 0, initialMargin: INITIAL_INVESTMENT_AMOUNT,
                    openTime: new Date(parseFloat(pos.updateTime || Date.now())), pricePrecision, side: positionSide,
                    unrealizedPnl: parseFloat(pos.unRealizedProfit), currentPrice: parseFloat(pos.markPrice), currentTPId: null, currentSLId: null,
                    partialCloseLossLevels: partialCloseSteps, nextPartialCloseLossIndex: 0,
                    closedQuantity: 0, partialClosePrices: [], hasRemovedInitialSL: false,
                    hasAdjustedSL6thClose: false, hasAdjustedSL8thClose: false, maxLeverageUsed: maxLeverage,
                };

                const relatedOrders = openOrdersOnBinance.filter(o => o.positionSide === positionSide && o.status === 'NEW' && o.symbol === TARGET_COIN_SYMBOL);
                 for (const order of relatedOrders) {
                     if (order.type === 'TAKE_PROFIT_MARKET') { recoveredPosition.currentTPId = order.orderId; recoveredPosition.initialTPPrice = parseFloat(order.stopPrice); }
                     else if (order.type === 'STOP_MARKET') { recoveredPosition.currentSLId = order.orderId; recoveredPosition.initialSLPrice = parseFloat(order.stopPrice); }
                 }

                 if (recoveredPosition.side === 'LONG' && recoveredPosition.maxLeverageUsed >= 75 && !recoveredPosition.currentSLId) recoveredPosition.hasRemovedInitialSL = true;

                if (positionSide === 'LONG' && parseFloat(pos.positionAmt) > 0) currentLongPosition = recoveredPosition;
                else if (positionSide === 'SHORT' && parseFloat(pos.positionAmt) < 0) currentShortPosition = recoveredPosition;
            }

            if (!currentLongPosition && !currentShortPosition) addLog(`Positions on Binance likely closed just before resume. Starting new cycle.`, true);
             else addLog(`Positions restored. Bot will monitor.`, true);

        } else addLog(`No active positions for ${TARGET_COIN_SYMBOL} found on Binance.`, true);

        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
        else addLog("Failed to init User Data Stream. PNL/trade updates might be delayed.", true);

        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot Running ---`, true);
        addLog(`Coin: ${TARGET_COIN_SYMBOL} | Capital/leg: ${INITIAL_INVESTMENT_AMOUNT} USDT.`, true);

        scheduleNextMainCycle();

        return 'Bot started successfully.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Start Error] ${errorMsg}`, true);
        addLog(`Bot stopping. Check logs.`, true);
        stopBotLogicInternal();
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`Scheduling auto-restart in ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => {
                addLog('Attempting auto-restart...', true);
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Bot start failed: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) { return 'Bot not running.'; }
    botRunning = false; addLog('--- Stopping Bot ---', true);
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    if (marketWs) { marketWs.close(); marketWs = null; }
    if (userDataWs) { userDataWs.close(); userDataWs = null; }
    if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    listenKey = null; currentMarketPrice = null;
    consecutiveApiErrors = 0;
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; addLog('Cancelled auto-restart schedule.', true); }
    addLog('--- Bot Stopped ---', true);
    botStartTime = null;
    currentLongPosition = null; currentShortPosition = null;
    totalProfit = 0; totalLoss = 0; netPNL = 0; isClosingPosition = false;
    return 'Bot stopped.';
}

async function cleanupAndResetCycle_Internal(symbol) {
    if (!botRunning) return;
    addLog(`Initiating cleanup for ${symbol}.`, true);

    try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positionsOnBinanceRaw.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remainingPositions.length > 0) {
            addLog(`Cleanup: Found ${remainingPositions.length} remaining positions. Forcing close.`, true);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                 closePosition(pos.symbol, Math.abs(parseFloat(pos.positionAmt)), `Remaining pos during cleanup`, sideToClose)
                 .catch(err => {
                     addLog(`Cleanup: Error closing remaining position ${pos.symbol} (${sideToClose}): ${err.message}`, true);
                     if (err instanceof CriticalApiError) stopBotLogicInternal();
                 });
            }
            // Re-check happens automatically as market close fills.
            return;
        } else {
            addLog(`Cleanup: No remaining positions on Binance.`);
        }
    } catch (error) {
         addLog(`Cleanup: Error checking positions on Binance: ${error.message}`, true);
          if (error instanceof CriticalApiError) { stopBotLogicInternal(); return; }
    }

    try { await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); } catch (error) { addLog(`Cleanup: Error cancelling orders: ${error.message}`, true); }

    currentLongPosition = null; currentShortPosition = null;
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; addLog('Cleanup: Monitor interval stopped.');}

    if (botRunning) { addLog(`Cleanup complete. Bot scheduling new cycle.`, true); scheduleNextMainCycle(); }
    else { addLog(`Cleanup complete. Bot is not running.`, true); }
}


const app = express();
app.use(express.json());

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, customLogData) => {
        if (!err && customLogData && customLogData.trim().length > 0) { res.send(customLogData.split('\n').slice(Math.max(0, customLogData.split('\n').length - 500)).join('\n')); }
        else {
            fs.readFile(BOT_LOG_FILE, 'utf8', (err, pm2LogData) => {
                if (err) return res.status(404).send(`Log file not found: ${BOT_LOG_FILE}`);
                const cleanData = pm2LogData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
                res.send(cleanData.split('\n').slice(Math.max(0, cleanData.split('\n').length - 500)).join('\n'));
            });
        }
    });
});

app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => { exec('pm2 jlist', (e, out) => { if (e) return reject(e); try { resolve(JSON.parse(out)); } catch (err) { reject(err); } }); });
        const botProcess = pm2List.find(p => p.name === THIS_BOT_PM2_NAME);

        let statusResponse = { pm2Status: 'NOT FOUND', internalBotStatus: 'STOPPED', configuredSymbol: TARGET_COIN_SYMBOL, configuredInitialCapital: INITIAL_INVESTMENT_AMOUNT, uptimeMinutes: 0, restartCount: 0, openPositions: { long: !!currentLongPosition, short: !!currentShortPosition }, liveStatus: "Not Running" };

        if (botProcess) {
            statusResponse.pm2Status = botProcess.pm2_env.status?.toUpperCase() || 'UNKNOWN';
            statusResponse.restartCount = botProcess.pm2_env.restart_time || 0;
            if (botProcess.pm2_env.pm_uptime) statusResponse.uptimeMinutes = Math.floor((Date.now() - botProcess.pm2_env.pm_uptime) / (1000 * 60));

            if (botProcess.pm2_env.status === 'online') {
                statusResponse.internalBotStatus = botRunning ? 'RUNNING' : 'STOPPED_INTERNALLY';
                if (botRunning) {
                    if (botStartTime) statusResponse.uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / (1000 * 60));
                    statusResponse.liveStatus = `OK | WS: MKT=${marketWs?'ON':'OFF'}, UD=${userDataWs?'ON':'OFF'} | Err:${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}`;
                } else statusResponse.liveStatus = `STOPPED`;
            } else statusResponse.liveStatus = `PM2 STATUS: ${statusResponse.pm2Status}`;
        }
        res.json(statusResponse);
    } catch (error) { console.error('Error getting status:', error); res.status(500).json({ success: false, message: 'Error getting bot status.' }); }
});

app.get('/api/bot_stats', async (req, res) => {
    try {
        const livePositionsOnBinanceRaw = botRunning ? await callSignedAPI('/fapi/v2/positionRisk', 'GET').catch(e => { addLog(`Error fetching live positions for stats: ${e.message}`, true); return []; }) : [];
        const livePositionsOnBinance = livePositionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

        let openPositionsData = [];
        const positionsToCheck = [currentLongPosition, currentShortPosition]; // Use local state as basis for what positions bot thinks it has
        for (const localPos of positionsToCheck) {
            if (!localPos) continue;
             const livePos = livePositionsOnBinance.find(p => p.positionSide === localPos.side);
            openPositionsData.push({
                symbol: localPos.symbol, side: localPos.side,
                 quantity: livePos ? Math.abs(parseFloat(livePos.positionAmt)) : localPos.quantity,
                initialQuantity: localPos.initialQuantity, entryPrice: livePos ? parseFloat(livePos.entryPrice) : localPos.entryPrice,
                currentPrice: livePos ? parseFloat(livePos.markPrice) : currentMarketPrice || localPos.currentPrice,
                unrealizedPnl: livePos ? parseFloat(livePos.unRealizedProfit) : localPos.unrealizedPnl,
                pricePrecision: localPos.pricePrecision,
                TPId: localPos.currentTPId, SLId: localPos.currentSLId, initialTPPrice: localPos.initialTPPrice, initialSLPrice: localPos.initialSLPrice,
                initialMargin: localPos.initialMargin,
                partialCloseLossLevels: localPos.partialCloseLossLevels, nextPartialCloseLossIndex: localPos.nextPartialCloseLossIndex,
                closedQuantity: localPos.closedQuantity, partialClosePrices: localPos.partialClosePrices,
                hasRemovedInitialSL: localPos.hasRemovedInitialSL, hasAdjustedSL6thClose: localPos.hasAdjustedSL6thClose, hasAdjustedSL8thClose: localPos.hasAdjustedSL8thClose,
                 currentProfitPercentage: localPos.initialMargin > 0 ? ((livePos ? parseFloat(livePos.unRealizedProfit) : localPos.unrealizedPnl) / localPos.initialMargin) * 100 : 0
            });
        }


        res.json({
            success: true, data: { totalProfit, totalLoss, netPNL, currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT, botRunning, targetSymbol: TARGET_COIN_SYMBOL, },
        });
    } catch (error) { console.error('Error getting bot stats:', error); res.status(500).json({ success: false, message: 'Error getting bot stats.' }); }
});

app.post('/api/configure', (req, res) => {
    const { coinConfigs } = req.body;
     if (!coinConfigs?.[0]?.symbol || typeof coinConfigs[0].initialAmount === 'undefined') { const msg = "Invalid config data."; addLog(msg, true); return res.status(400).json({ success: false, message: msg }); }
     if (botRunning) { const msg = 'Stop bot before re-configuring.'; addLog(`Config denied: Bot running.`, true); return res.status(409).json({ success: false, message: msg }); }

    const config = coinConfigs[0];
    const oldTargetCoinSymbol = TARGET_COIN_SYMBOL;
    const newTargetCoinSymbol = config.symbol.trim().toUpperCase();
    const newInitialAmount = parseFloat(config.initialAmount);

    if (isNaN(newInitialAmount) || newInitialAmount <= 0) { const msg = `Invalid initial amount: ${config.initialAmount}.`; addLog(msg, true); return res.status(400).json({ success: false, message: msg }); }

    TARGET_COIN_SYMBOL = newTargetCoinSymbol; INITIAL_INVESTMENT_AMOUNT = newInitialAmount;

    if (oldTargetCoinSymbol !== TARGET_COIN_SYMBOL) {
        addLog(`Target symbol changed from ${oldTargetCoinSymbol} to ${TARGET_COIN_SYMBOL}. Resetting state.`, true);
        currentLongPosition = null; currentShortPosition = null; totalProfit = 0; totalLoss = 0; netPNL = 0; exchangeInfoCache = null; isClosingPosition = false;
    } else { addLog(`Config updated for ${TARGET_COIN_SYMBOL}.`, true); }

    addLog(`Config updated. Symbol: ${TARGET_COIN_SYMBOL}, Capital: ${INITIAL_INVESTMENT_AMOUNT}. Restart bot to apply.`, true);
    res.json({ success: true, message: 'Configuration updated.' });
});

app.get('/start_bot_logic', async (req, res) => {
     try {
        const message = await startBotLogicInternal();
        res.json({ success: botRunning, message, botRunning });
     } catch (error) {
        console.error('Unexpected error during startBotLogic:', error);
        res.status(500).json({ success: false, message: `An unexpected error occurred: ${error.message}`, botRunning: botRunning });
     }
});

app.get('/stop_bot_logic', (req, res) => {
     try {
        const message = stopBotLogicInternal();
        res.json({ success: !botRunning, message, botRunning });
     } catch (error) {
         console.error('Error during stopBotLogic:', error);
        res.status(500).json({ success: false, message: `An error occurred during stop: ${error.message}`, botRunning: botRunning });
     }
});

app.listen(WEB_SERVER_PORT, () => { addLog(`Web server listening on port ${WEB_SERVER_PORT}`, true); });
