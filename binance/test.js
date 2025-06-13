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
            if (err) console.error('Lỗi ghi log vào file tùy chỉnh:', err);
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
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Thiếu API_KEY hoặc SECRET_KEY. Vui lòng kiểm tra config.js.");
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath, requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };

    if (method === 'GET' || method === 'DELETE') { requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/json'; }
    else if (method === 'POST' || method === 'PUT') { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else throw new Error(`Phương thức không hỗ trợ: ${method}`);

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`, true);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
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
        addLog(`Lỗi Public API Binance (GET ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`, true);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = data.serverTime - Date.now();
        addLog(`Đồng bộ thời gian: độ lệch ${serverTimeOffset} ms.`);
    } catch (error) {
        addLog(`Lỗi đồng bộ thời gian: ${error.message}.`, true);
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
        addLog(`Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

async function setLeverage(symbol, leverage) {
    try {
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol} thành công.`);
        return true;
    } catch (error) {
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol} thất bại: ${error.msg || error.message}`, true);
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
        addLog('Đã tải thông tin sàn.');
        return exchangeInfoCache;
    } catch (error) {
        addLog('Lỗi tải thông tin sàn: ' + (error.msg || error.message), true);
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
        if (error.code !== -2011) addLog(`Lỗi hủy lệnh ${orderId || 'tất cả'} cho ${symbol} (${positionSide || 'tất cả'}): ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnl, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;
    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED' || parseFloat(realizedPnl) === 0) return;

    if (parseFloat(realizedPnl) > 0) totalProfit += parseFloat(realizedPnl);
    else totalLoss += Math.abs(parseFloat(realizedPnl));
    netPNL = totalProfit - totalLoss;

    addLog(`Lệnh khớp: ${positionSide} ${symbol} | PNL: ${parseFloat(realizedPnl).toFixed(2)} USDT | Tổng PNL: ${netPNL.toFixed(2)}`, true);

    let isBotMainClosure = false;
    if (currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId)) isBotMainClosure = true;
    else if (currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId)) isBotMainClosure = true;

    if (isBotMainClosure) {
        addLog(`Lệnh TP/SL chính cho ${positionSide} khớp. Đóng vị thế đối ứng và reset chu kỳ.`, true);
        let otherPosition = (positionSide === 'LONG' && currentShortPosition) ? currentShortPosition : (positionSide === 'SHORT' && currentLongPosition) ? currentLongPosition : null;

        if(positionSide === 'LONG') currentLongPosition = null;
        else currentShortPosition = null;

        if (otherPosition) {
             closePosition(TARGET_COIN_SYMBOL, otherPosition.quantity, `Lệnh đối ứng ${positionSide} khớp TP/SL`, otherPosition.side)
             .catch(err => {
                  addLog(`Lỗi đóng vị thế đối ứng: ${err.message}`, true);
                  if(err instanceof CriticalApiError) stopBotLogicInternal();
              });
        } else {
            addLog("Không tìm thấy vị thế đối ứng hoặc đã đóng. Thực hiện dọn dẹp.", true);
             cleanupAndResetCycle_Internal(TARGET_COIN_SYMBOL)
             .catch(err => {
                 addLog(`Lỗi dọn dẹp sau khi chỉ một lệnh khớp: ${err.message}`, true);
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
    addLog(`Đang đóng lệnh ${positionSide} cho ${symbol} (Lý do: ${reason}).`);
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) { addLog(`Không tìm thấy thông tin symbol cho ${symbol}. Không đóng lệnh.`, true); return; }
        const quantityPrecision = symbolInfo.quantityPrecision;

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} (${positionSide}) đã đóng trên sàn. Lý do: ${reason}.`, true);
             if(positionSide === 'LONG' && currentLongPosition) currentLongPosition = null;
             if(positionSide === 'SHORT' && currentShortPosition) currentShortPosition = null;
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
             if (actualQuantityToClose <= 0) return;
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';

             await cancelOpenOrdersForSymbol(symbol, null, positionSide);
            await sleep(200);

            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: adjustedActualQuantity, reduceOnly: true });
            addLog(`Đã gửi lệnh đóng thị trường cho ${symbol} (${positionSide}).`, true);
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol} (${positionSide}): ${error.msg || error.message}`, true);
         if (error instanceof CriticalApiError) stopBotLogicInternal();
    } finally {
        isClosingPosition = false;
    }
}

async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (symbol !== TARGET_COIN_SYMBOL || !botRunning || (tradeDirection === 'LONG' && currentLongPosition) || (tradeDirection === 'SHORT' && currentShortPosition)) {
        return null;
    }

    addLog(`Đang mở lệnh ${tradeDirection} cho ${symbol}. Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) { addLog(`Không tìm thấy thông tin symbol cho ${symbol}. Không thể mở lệnh.`, true); return null; }
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) { addLog(`Đặt đòn bẩy thất bại. Không thể mở lệnh.`, true); return null; }
        await sleep(500);

        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) { addLog(`Không lấy được giá hiện tại. Không thể mở lệnh.`, true); return null; }

        const capitalToUse = INITIAL_INVESTMENT_AMOUNT;
        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity <= 0 || quantity * currentPrice < minNotional) { addLog(`Số lượng tính toán ${quantity} quá nhỏ. Không thể mở lệnh.`, true); return null; }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        addLog(`Gửi lệnh MARKET mở ${tradeDirection} ${symbol}. Qty: ${quantity.toFixed(quantityPrecision)}.`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity, newOrderRespType: 'FULL' });

        await sleep(1000);

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) { addLog(`Không tìm thấy vị thế ${tradeDirection} trên Binance sau khi gửi lệnh.`, true); return null; }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt));
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now()));

        addLog(`Đã mở vị thế ${tradeDirection} cho ${symbol} thành công.`, true);
        addLog(`-> Số lượng: ${actualQuantity.toFixed(quantityPrecision)}, Giá vào: ${entryPrice.toFixed(pricePrecision)}`, true);

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
         // Re-get tickSize within this scope
        const symbolInfoCurrent = await getSymbolDetails(symbol); // Use a new const name
        const tickSize_current = symbolInfoCurrent ? symbolInfoCurrent.tickSize : 0.001; // Use a new const name

        if (tradeDirection === 'LONG') {
             initialCalculatedSLPrice = Math.floor((entryPrice - priceChangeForSL) / tickSize_current) * tickSize_current;
             initialCalculatedTPPrice = Math.floor((entryPrice + priceChangeForTP) / tickSize_current) * tickSize_current;
        } else {
             initialCalculatedSLPrice = Math.ceil((entryPrice + priceChangeForSL) / tickSize_current) * tickSize_current;
             initialCalculatedTPPrice = Math.ceil((entryPrice - priceChangeForTP) / tickSize_current) * tickSize_current;
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
        addLog(`Lỗi mở lệnh ${tradeDirection} cho ${symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
        await sleep(5000);
        return null;
    }
}


async function placeInitialTPAndSL(position) {
    if (!position || !botRunning) return;
    addLog(`Đang đặt lệnh TP/SL ban đầu cho ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) { addLog(`Không tìm thông tin symbol cho ${position.symbol}. Không đặt TP/SL ban đầu.`, true); return; }

        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) { addLog(`Không tìm thấy vị thế ${position.side} trên Binance trong lúc đặt TP/SL ban đầu.`, true); return; }
        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        if (actualQuantity <= 0) return;

        const { pricePrecision } = symbolDetails;
        const slPrice = position.initialSLPrice;
        const tpPrice = position.initialTPPrice;
        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';

        let placedSLOrderId = null;
        try {
            if (position.side === 'LONG' && position.maxLeverageUsed >= 75) {
                 addLog(`Bỏ qua đặt SL ban đầu cho LONG đòn bẩy cao.`, true);
                 position.hasRemovedInitialSL = true;
            } else {
                 const isSLInvalid = (position.side === 'LONG' && slPrice >= parseFloat(currentPosOnBinance.entryPrice)) || (position.side === 'SHORT' && slPrice <= parseFloat(currentPosOnBinance.entryPrice));
                 if (isSLInvalid) { addLog(`Giá SL tính toán ban đầu (${slPrice}) không hợp lệ cho ${position.side}.`, true); position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true; }
                else {
                    addLog(`Đặt SL ban đầu @ ${slPrice.toFixed(pricePrecision)}.`);
                     const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: slPrice, closePosition: 'true', newOrderRespType: 'FULL' });
                     placedSLOrderId = slOrderResult.orderId; position.currentSLId = placedSLOrderId; position.initialSLPrice = slPrice; position.hasRemovedInitialSL = false;
                     addLog(`Đã đặt SL ban đầu. OrderId: ${placedSLOrderId}`);
                 }
            }
        } catch (slError) {
             addLog(`Đặt SL ban đầu thất bại: ${slError.msg || slError.message}`, true);
             position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true; if (slError.code === -2021 || (slError.msg?.includes('immediately trigger'))) addLog(`SL đã khớp ngay lập tức.`, true);
             if (slError instanceof CriticalApiError) throw slError;
        }
        await sleep(200);

        let placedTPOrderId = null;
        try {
             const isTPInvalid = (position.side === 'LONG' && tpPrice <= parseFloat(currentPosOnBinance.entryPrice)) || (position.side === 'SHORT' && tpPrice >= parseFloat(currentPosOnBinance.entryPrice));
            if(isTPInvalid) { addLog(`Giá TP tính toán ban đầu (${tpPrice}) không hợp lệ cho ${position.side}.`, true); position.currentTPId = null; position.initialTPPrice = 0; }
             else {
                 addLog(`Đặt TP ban đầu @ ${tpPrice.toFixed(pricePrecision)}.`);
                const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: tpPrice, closePosition: 'true', newOrderRespType: 'FULL' });
                 placedTPOrderId = tpOrderResult.orderId; position.currentTPId = placedTPOrderId; position.initialTPPrice = tpPrice;
                 addLog(`Đã đặt TP ban đầu. OrderId: ${placedTPOrderId}`);
            }
        } catch (tpError) {
             addLog(`Đặt TP ban đầu thất bại: ${tpError.msg || tpError.message}`, true); position.currentTPId = null; position.initialTPPrice = 0; if (tpError.code === -2021 || (tpError.msg?.includes('immediately trigger'))) addLog(`TP đã khớp ngay lập tức.`, true);
             if (tpError instanceof CriticalApiError) throw tpError;
        }
        await sleep(200);

    } catch (error) {
        addLog(`Lỗi trong placeInitialTPAndSL cho ${position.side} ${position.symbol}: ${error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function checkAndRecreateMissingTPAndSL(position) {
    if (!position || !botRunning) return;
    addLog(`Kiểm tra lệnh TP/SL ban đầu bị thiếu cho ${position.side} ${position.symbol}...`);

    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: position.symbol });
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
        if (!currentPosOnBinance) { addLog(`Không tìm thấy vị thế ${position.side} trên Binance trong lúc kiểm tra lại TP/SL. Bỏ qua.`, true); return; }

        const shouldHaveSL = !(position.side === 'LONG' && position.maxLeverageUsed >= 75);

        const hasActiveTP = position.currentTPId ? openOrders.some(o => o.orderId === position.currentTPId && o.status === 'NEW') : false;
        const hasActiveSL = position.currentSLId ? openOrders.some(o => o.orderId === position.currentSLId && o.status === 'NEW') : false;

        if (!hasActiveTP) {
            addLog(`Lệnh TP bị thiếu cho ${position.side} ${position.symbol}. Tạo lại...`);
             await placeInitialTPAndSL(position);
        }

        if (!hasActiveSL && shouldHaveSL) {
            addLog(`Lệnh SL bị thiếu cho ${position.side} ${position.symbol}. Tạo lại...`);
            await placeInitialTPAndSL(position);
        } else if (hasActiveSL && !shouldHaveSL) {
            addLog(`Lệnh SL tồn tại cho ${position.side} ${position.symbol}, nhưng lẽ ra không nên có (đòn bẩy cao). Hủy lệnh SL.`);
            await updateStopLoss(position, null);
        }

    } catch (error) {
        addLog(`Lỗi kiểm tra/tạo lại TP/SL cho ${position.side} ${position.symbol}: ${error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function scheduleInitialTPAndSLPlacement() {
    if (!botRunning || !currentLongPosition || !currentShortPosition) return;
    addLog(`Lên lịch đặt lệnh TP/SL ban đầu sau 5 giây.`);
    setTimeout(async () => {
        if (!botRunning) return;
        try {
             addLog(`Bắt đầu đặt lệnh TP/SL ban đầu (đã lên lịch).`);
            if (currentLongPosition) await placeInitialTPAndSL(currentLongPosition);
            if (currentShortPosition) await placeInitialTPAndSL(currentShortPosition);

            if (botRunning && (currentLongPosition || currentShortPosition)) {
                addLog(`Lên lịch kiểm tra lệnh TP/SL thiếu sau 20 giây.`);
                setTimeout(async () => {
                    if (!botRunning) return;
                     addLog(`Bắt đầu kiểm tra và tạo lại TP/SL ban đầu thiếu (đã lên lịch).`);
                    if (currentLongPosition) await checkAndRecreateMissingTPAndSL(currentLongPosition);
                    if (currentShortPosition) await checkAndRecreateMissingTPAndSL(currentShortPosition);
                }, 20000);
            }
        } catch (error) {
            addLog(`Lỗi trong lịch trình đặt TP/SL ban đầu: ${error.message}`, true);
             if (error instanceof CriticalApiError) stopBotLogicInternal();
        }
    }, 5000);
}

async function addPosition(position, quantityToReopen, reason) {
    if (!position || quantityToReopen <= 0 || !botRunning) return;

    const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
    const currentPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);
    if (!currentPositionOnBinance) {
        addLog(`Không tìm thấy vị thế ${position.side} trên sàn. Không thể thêm lượng.`, true);
        if(position.side === 'LONG') currentLongPosition = null;
        else currentShortPosition = null;
        return;
    }

    addLog(`Thêm ${quantityToReopen.toFixed(position.quantityPrecision)} lượng vào vị thế ${position.side} ${position.symbol} (Lý do: ${reason}).`);
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) { addLog(`Không tìm thông tin symbol cho ${position.symbol}. Không thể thêm lượng.`, true); return; }

        const currentPrice = await getCurrentPrice(position.symbol);
        if (!currentPrice) { addLog(`Không lấy được giá hiện tại. Không thể thêm lượng.`, true); return; }

        const { quantityPrecision, minNotional, stepSize } = symbolDetails;
        let adjustedQuantityToReopen = Math.floor(quantityToReopen / stepSize) * stepSize;
        adjustedQuantityToReopen = parseFloat(adjustedQuantityToReopen.toFixed(quantityPrecision));

        if (adjustedQuantityToReopen <= 0 || adjustedQuantityToReopen * currentPrice < minNotional) { addLog(`Lượng ${adjustedQuantityToReopen} quá nhỏ. Không thể thêm.`, true); return; }

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSide, positionSide: position.side, type: 'MARKET', quantity: adjustedQuantityToReopen, newOrderRespType: 'FULL' });

        addLog(`Đã gửi lệnh thêm lượng cho ${position.side} ${position.symbol}.`);
        await sleep(1000);

        addLog(`Reset trạng thái đóng từng phần/SL và đặt lại TP/SL sau khi thêm lượng.`);
         [currentLongPosition, currentShortPosition].forEach(p => {
            if (p) {
                 p.nextPartialCloseLossIndex = 0; p.closedQuantity = 0; p.partialClosePrices = []; p.hasAdjustedSL6thClose = false; p.hasAdjustedSL8thClose = false;
            }
         });

        if (currentLongPosition) await recalculateAndPlaceTPAndSL(currentLongPosition);
        if (currentShortPosition) await recalculateAndPlaceTPAndSL(currentShortPosition);

    } catch (error) {
        addLog(`Lỗi thêm lượng vào vị thế ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) throw error;
    }
}

async function recalculateAndPlaceTPAndSL(position) {
    if (!position || !botRunning) return;
    addLog(`Tính toán lại và đặt lại TP/SL cho ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) { addLog(`Không tìm thông tin symbol cho ${position.symbol}. Không thể đặt TP/SL.`, true); return; }

        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
        if (!currentPosOnBinance) { addLog(`Không tìm thấy vị thế ${position.side} trên Binance. Không thể đặt TP/SL.`, true); return; }
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

         let winningPosLocal = (currentLongPosition && currentShortPosition && currentLongPosition.unrealizedPnl > 0) ? currentLongPosition : (currentLongPosition && currentShortPosition && currentShortPosition.unrealizedPnl > 0) ? currentShortPosition : null;
         let losingPosLocal = (currentLongPosition && currentShortPosition && currentLongPosition.unrealizedPnl < 0) ? currentLongPosition : (currentLongPosition && currentShortPosition && currentShortPosition.unrealizedPnl < 0) ? currentShortPosition : null;

         if (winningPosLocal && losingPosLocal) {
             if (winningPosLocal.partialClosePrices.length >= 2 && winningPosLocal.hasAdjustedSL6thClose) finalSLPriceForOrder = losingPosLocal.partialClosePrices[1];
             if (winningPosLocal.partialClosePrices.length >= 5 && winningPosLocal.hasAdjustedSL8thClose && position.side === winningPosLocal.side) finalSLPriceForOrder = losingPosLocal.partialClosePrices[4];
         }

        let placedSLOrderId = null;
        try {
             const isSLInvalid = (position.side === 'LONG' && finalSLPriceForOrder >= actualEntryPrice) || (position.side === 'SHORT' && finalSLPriceForOrder <= actualEntryPrice);
             if (isSLInvalid) { addLog(`Giá SL (${finalSLPriceForOrder}) không hợp lệ. Không đặt lệnh SL.`, true); position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;}
            else {
                 addLog(`Đặt lệnh SL @ ${finalSLPriceForOrder.toFixed(pricePrecision)}.`);
                const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: finalSLPriceForOrder, closePosition: 'true', newOrderRespType: 'FULL' });
                placedSLOrderId = slOrderResult.orderId; position.currentSLId = placedSLOrderId; position.initialSLPrice = finalSLPriceForOrder; position.hasRemovedInitialSL = false;
                addLog(`Đã đặt lệnh SL. OrderId: ${placedSLOrderId}`);
            }
        } catch (slError) {
             addLog(`Đặt lệnh SL thất bại: ${slError.msg || slError.message}`, true); position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;
             if (slError instanceof CriticalApiError) throw slError;
        }
        await sleep(200);

        let placedTPOrderId = null;
        try {
            const isTPInvalid = (position.side === 'LONG' && newTPPrice <= actualEntryPrice) || (position.side === 'SHORT' && newTPPrice >= actualEntryPrice);
             if (isTPInvalid) { addLog(`Giá TP (${newTPPrice}) không hợp lệ. Không đặt lệnh TP.`, true); position.currentTPId = null; position.initialTPPrice = 0;}
             else {
                 addLog(`Đặt lệnh TP @ ${newTPPrice.toFixed(pricePrecision)}.`);
                const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'TAKE_PROFIT_MARKET', quantity: actualQuantity, stopPrice: newTPPrice, closePosition: 'true', newOrderRespType: 'FULL' });
                 placedTPOrderId = tpOrderResult.orderId; position.currentTPId = placedTPOrderId; position.initialTPPrice = newTPPrice;
                 addLog(`Đã đặt lệnh TP. OrderId: ${placedTPOrderId}`);
             }
        } catch (tpError) {
             addLog(`Đặt lệnh TP thất bại: ${tpError.msg || tpError.message}`, true); position.currentTPId = null; position.initialTPPrice = 0;
             if (tpError instanceof CriticalApiError) throw tpError;
        }
        await sleep(200);

    } catch (error) {
        addLog(`Lỗi tính toán lại và đặt TP/SL cho ${position.side} ${position.symbol}: ${error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function updateStopLoss(position, targetSLPrice) {
    if (!position || !botRunning) return;
    addLog(`Cập nhật SL cho ${position.side} ${position.symbol}${targetSLPrice !== null ? ` về giá ${targetSLPrice.toFixed(position.pricePrecision)}` : ' (hủy)'}.`);

    try {
         if (position.currentSLId) {
             addLog(`Hủy lệnh SL hiện có ${position.currentSLId}.`);
             await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side);
             position.currentSLId = null;
         }
         await sleep(300);

        let isCurrentPosWinning = false;
         if (currentLongPosition?.symbol === position.symbol && currentLongPosition.unrealizedPnl > 0) isCurrentPosWinning = true;
         if (currentShortPosition?.symbol === position.symbol && currentShortPosition.unrealizedPnl > 0) isCurrentPosWinning = true;

        if (targetSLPrice === null) {
             if (isCurrentPosWinning && !position.hasRemovedInitialSL) position.hasRemovedInitialSL = true;
             addLog(`Đã hủy SL cho ${position.side}.`);
            position.initialSLPrice = null;
             return;
        }


        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);
        if (!currentPosOnBinance) { addLog(`Không tìm thấy vị thế ${position.side} trên Binance. Không cập nhật SL.`, true); return; }

        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        if (actualQuantity <= 0) return;

         const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);
         const isSLInvalid = (position.side === 'LONG' && targetSLPrice >= actualEntryPrice) || (position.side === 'SHORT' && targetSLPrice <= actualEntryPrice);
         if (isSLInvalid) {
            addLog(`Giá SL (${targetSLPrice}) không hợp lệ cho ${position.side}. Bỏ qua cập nhật.`, true);
             position.currentSLId = null; position.initialSLPrice = null; position.hasRemovedInitialSL = true;
             return;
         }


        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';
        const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: orderSideToClose, positionSide: position.side, type: 'STOP_MARKET', quantity: actualQuantity, stopPrice: targetSLPrice, closePosition: 'true', newOrderRespType: 'FULL' });

        position.currentSLId = slOrderResult.orderId; position.initialSLPrice = targetSLPrice; position.hasRemovedInitialSL = false;
        addLog(`Đã đặt SL mới cho ${position.side} ${position.symbol}. OrderId: ${slOrderResult.orderId}.`, true);
        await sleep(200);

    } catch (error) {
        addLog(`Lỗi cập nhật SL cho ${position.side} ${position.symbol}: ${error.msg || error.message}`, true);
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

        if (currentLongPosition) {
             const livePos = positionsOnBinance.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'LONG' && parseFloat(p.positionAmt) !== 0);
             if (!livePos) { addLog(`Vị thế LONG đã đóng trên Binance.`, true); currentLongPosition = null; }
             else { currentLongPosition.unrealizedPnl = parseFloat(livePos.unRealizedProfit); currentLongPosition.currentPrice = parseFloat(livePos.markPrice); currentLongPosition.quantity = Math.abs(parseFloat(livePos.positionAmt)); currentLongPosition.entryPrice = parseFloat(livePos.entryPrice); hasActivePositionAfterSync = true; }
        }
        if (currentShortPosition) {
             const livePos = positionsOnBinance.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) !== 0);
             if (!livePos) { addLog(`Vị thế SHORT đã đóng trên Binance.`, true); currentShortPosition = null; }
             else { currentShortPosition.unrealizedPnl = parseFloat(livePos.unRealizedProfit); currentShortPosition.currentPrice = parseFloat(livePos.markPrice); currentShortPosition.quantity = Math.abs(parseFloat(livePos.positionAmt)); currentShortPosition.entryPrice = parseFloat(livePos.entryPrice); hasActivePositionAfterSync = true; }
        }

        if (!hasActivePositionAfterSync) {
             addLog(`Không có vị thế nào đang mở trên Binance.`, true);
             if (currentLongPosition || currentShortPosition) { addLog(`Trạng thái nội bộ không khớp, buộc reset.`, true); currentLongPosition = null; currentShortPosition = null; }
            await cleanupAndResetCycle_Internal(TARGET_COIN_SYMBOL);
            return;
        }

        if (currentLongPosition && currentShortPosition) {
            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl > 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
            else if (currentShortPosition.unrealizedPnl > 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
            else return;

            const losingSymbolDetails = await getSymbolDetails(losingPos.symbol);
            if (!losingSymbolDetails) { addLog(`Không tìm thông tin symbol cho lệnh lỗ.`, true); return; }

            const currentProfitPercentage = winningPos.initialMargin > 0 ? (winningPos.unrealizedPnl / winningPos.initialMargin) * 100 : 0;

             if (winningPos.side === 'LONG' && winningPos.maxLeverageUsed >= 75 && winningPos.currentSLId && !winningPos.hasRemovedInitialSL && currentProfitPercentage > 0.5) {
                 addLog(`LONG đang lãi (${currentProfitPercentage.toFixed(2)}%). Hủy SL ban đầu.`, true);
                 await updateStopLoss(winningPos, null);
            }

            const losingPosIndex = losingPos.nextPartialCloseLossIndex;
            const nextLossCloseLevel = losingPos.partialCloseLossLevels[losingPosIndex];
             if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel && losingPosIndex < 8) {
                 let quantityToAttemptClose = losingPos.initialQuantity * 0.10;
                 quantityToAttemptClose = Math.floor(quantityToAttemptClose / losingSymbolDetails.stepSize) * losingSymbolDetails.stepSize;
                 quantityToAttemptClose = parseFloat(quantityToAttemptClose.toFixed(losingSymbolDetails.quantityPrecision));

                 const losingPosOnBinanceCurrent = positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side);
                 if (Math.abs(parseFloat(losingPosOnBinanceCurrent?.positionAmt || '0')) >= quantityToAttemptClose && quantityToAttemptClose > 0) {
                    addLog(`Lệnh lãi đạt ${nextLossCloseLevel}%. Đóng 10% lệnh lỗ ${losingPos.symbol} (Lần ${losingPosIndex + 1}/8).`, true);
                    await closePartialPosition(losingPos, 10, 'LOSS');
                    losingPos.nextPartialCloseLossIndex++;
                    winningPos.nextPartialCloseLossIndex = losingPos.nextPartialCloseLossIndex;
                 } else if (Math.abs(parseFloat(losingPosOnBinanceCurrent?.positionAmt || '0')) > 0) {
                     addLog(`Lượng lệnh lỗ (${Math.abs(parseFloat(losingPosOnBinanceCurrent?.positionAmt || '0'))}) không đủ để đóng từng phần ${losingPosIndex + 1}. Bỏ qua.`);
                 } else {
                     addLog(`Lệnh lỗ ${losingPos.symbol} đã đóng. Đánh dấu mốc tối đa.`, true);
                      if (losingPosIndex < 8) { losingPos.nextPartialCloseLossIndex = 8; winningPos.nextPartialCloseLossIndex = 8; }
                 }
             } else if (losingPosIndex >= 8 && Math.abs(parseFloat(positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')) > 0) {
                 addLog(`Đã thử đóng 8 lần lệnh lỗ. Buộc đóng vị thế còn lại.`, true);
                 await closePosition(losingPos.symbol, Math.abs(parseFloat(positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0')), 'Buộc đóng sau 8 lần thử đóng từng phần', losingPos.side);
             }


             const partialCloseCount = winningPos.nextPartialCloseLossIndex;

             if (partialCloseCount >= 6 && !winningPos.hasAdjustedSL6thClose) {
                 if (losingPos.partialClosePrices.length >= 2) {
                     const slTargetPrice = losingPos.partialClosePrices[1];
                     addLog(`Mốc 6 đạt. Điều chỉnh SL cả hai lệnh về giá entry lệnh lỗ lúc đóng lần 2 (${slTargetPrice}).`, true);
                     if (currentLongPosition) await updateStopLoss(currentLongPosition, slTargetPrice);
                     if (currentShortPosition) await updateStopLoss(currentShortPosition, slTargetPrice);
                    winningPos.hasAdjustedSL6thClose = true;
                 }
             }

             if (partialCloseCount >= 8 && !winningPos.hasAdjustedSL8thClose && winningPos) {
                 if (losingPos.partialClosePrices.length >= 5) {
                     const slTargetPrice = losingPos.partialClosePrices[4];
                     const remainingLosingQty = Math.abs(parseFloat(positionsOnBinance.find(p => p.symbol === losingPos.symbol && p.positionSide === losingPos.side)?.positionAmt || '0'));

                    if (remainingLosingQty < (losingPos.initialQuantity * 0.01) ) {
                         addLog(`Mốc 8 đạt. Lệnh lỗ đã đóng. Điều chỉnh SL lệnh lãi ${winningPos.side} về giá entry lệnh lỗ lúc đóng lần 5 (${slTargetPrice}).`, true);
                         await updateStopLoss(winningPos, slTargetPrice);
                         winningPos.hasAdjustedSL8thClose = true;
                    } else {
                        addLog(`Mốc 8 đạt, nhưng lệnh lỗ còn lượng đáng kể (${remainingLosingQty}).`);
                    }
                 }
            }

             if (winningPos.nextPartialCloseLossIndex > 0 && winningPos.nextPartialCloseLossIndex <= 7) {
                 const currentWinningProfitPercentage = winningPos.initialMargin > 0 ? (winningPos.unrealizedPnl / winningPos.initialMargin) * 100 : 0;
                 if (currentWinningProfitPercentage <= 0.1 && losingPos.closedQuantity > 0) {
                     const losingSymbolDetailsLocal = losingSymbolDetails; // Already fetched losingSymbolDetails above
                     if (losingSymbolDetailsLocal) {
                         addLog(`Lệnh lãi trở về 0%. Thêm lượng (${losingPos.closedQuantity.toFixed(losingSymbolDetailsLocal.quantityPrecision)}) vào lệnh lỗ ${losingPos.symbol}.`, true);
                         await addPosition(losingPos, losingPos.closedQuantity, 'Lệnh lãi trở về 0%');
                     } else {
                        addLog(`Không tìm thấy thông tin symbol để thêm lượng vào lệnh lỗ ${losingPos.symbol}.`, true);
                     }
                 }
             }
        } else if (currentLongPosition || currentShortPosition) {
             const remainingPos = currentLongPosition || currentShortPosition;
             // Recheck and recreate missing TP/SL on the remaining leg if necessary.
             // Let the scheduled checkAndRecreateMissingTPAndSL after initial open handle this primarily.
        }
    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
};


async function runTradingLogic() {
    if (!botRunning) { addLog('Bot không chạy. Bỏ qua chu kỳ giao dịch.'); return; }
    try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);
        if (positionsOnBinance.length > 0 || currentLongPosition || currentShortPosition) {
            addLog(`Phát hiện vị thế đang mở. Chuyển sang chế độ theo dõi.`, true);
            scheduleNextMainCycle();
            return;
        }
    } catch (error) {
         addLog(`Lỗi kiểm tra vị thế trước khi mở lệnh: ${error.message}`, true);
         if(error instanceof CriticalApiError) { stopBotLogicInternal(); }
         else { addLog(`Thử lại kiểm tra trong 5 giây.`, true); nextScheduledCycleTimeout = setTimeout(runTradingLogic, 5000); }
         return;
    }

     addLog('Bắt đầu chu kỳ giao dịch mới: Mở cả lệnh LONG và SHORT.', true);
    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        let usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        const minimumRequiredCapital = INITIAL_INVESTMENT_AMOUNT * 2 * 1.1;
        if (usdtAsset < minimumRequiredCapital) {
            addLog(`Số dư USDT thấp (${usdtAsset.toFixed(2)}). Cần khoảng ${minimumRequiredCapital.toFixed(2)}. Bỏ qua.`, true);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000); return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) { addLog(`Không lấy được đòn bẩy cho ${TARGET_COIN_SYMBOL}. Bỏ qua.`, true); nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000); return; }

        addLog(`Mở lệnh LONG cho ${TARGET_COIN_SYMBOL}.`);
        const longPosAttempt = await openPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!longPosAttempt) { addLog('Mở lệnh LONG thất bại. Bỏ qua chu kỳ.'); nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000); return; }
        currentLongPosition = longPosAttempt; await sleep(2000);

         try {
             const accountAfterLong = await callSignedAPI('/fapi/v2/account', 'GET');
             usdtAsset = parseFloat(accountAfterLong.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
         } catch (balError) { addLog(`Lỗi lấy số dư sau mở LONG: ${balError.message}.`, true); }

        addLog(`Mở lệnh SHORT cho ${TARGET_COIN_SYMBOL}.`);
        const shortPosAttempt = await openPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!shortPosAttempt) {
            addLog('Mở lệnh SHORT thất bại. Thử đóng lệnh LONG đã mở.', true);
            if (currentLongPosition) { closePosition(TARGET_COIN_SYMBOL, currentLongPosition.quantity, 'Lỗi mở lệnh SHORT', 'LONG').catch(err => { addLog(`Lỗi đóng LONG sau lỗi SHORT: ${err.message}`, true); if(err instanceof CriticalApiError) stopBotLogicInternal(); }); currentLongPosition = null;}
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000); return;
        }
         currentShortPosition = shortPosAttempt;

        addLog(`Đã mở thành công cả hai vị thế cho ${TARGET_COIN_SYMBOL}.`, true);
        scheduleInitialTPAndSLPlacement(); // Schedule đặt TP/SL 5s sau
        scheduleNextMainCycle(); // Bắt đầu theo dõi

    } catch (error) {
        addLog(`Lỗi trong chu kỳ giao dịch chính: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        else { addLog(`Thử lại chu kỳ giao dịch chính trong 10 giây.`, true); nextScheduledCycleTimeout = setTimeout(runTradingLogic, 10000); }
    }
}

// Move scheduleNextMainCycle definition ABOVE its usage
async function scheduleNextMainCycle() {
    if (!botRunning) return;
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
                             addLog(`Lỗi kiểm tra định kỳ: ${error.message}`, true);
                             if (error instanceof CriticalApiError) stopBotLogicInternal();
                        }
                    } else if (!botRunning && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; addLog('Ngừng kiểm tra định kỳ do bot dừng.'); }
                    else if ((!currentLongPosition && !currentShortPosition) && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; addLog('Ngừng kiểm tra định kỳ do không còn vị thế nội bộ.'); if(botRunning) scheduleNextMainCycle(); }
                }, 5000);
                 addLog(`Đã khởi động kiểm tra vị thế định kỳ.`);
            }
        } else {
             addLog(`Không có vị thế đang mở. Lên lịch chu kỳ mới trong 2 giây.`);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế trước khi lên lịch chu kỳ: ${error.msg || error.message}`, true);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        else {
             addLog(`Thử lại kiểm tra và lên lịch trong 5 giây sau lỗi.`);
             nextScheduledCycleTimeout = setTimeout(scheduleNextMainCycle, 5000);
        }
    }
}

async function getListenKey() {
    try {
        const response = await callSignedAPI('/fapi/v1/listenKey', 'POST');
        addLog(`Listen Key nhận được: ${response.listenKey}`);
        return response.listenKey;
    } catch (error) {
        addLog(`Lỗi lấy Listen Key: ${error.msg || error.message}`, true);
        return null;
    }
}

async function keepAliveListenKey(key) {
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: key });
        addLog(`Listen Key ${key} đã được làm mới.`);
    } catch (error) {
        addLog(`Lỗi làm mới Listen Key ${key}: ${error.msg || error.message}`, true);
        if (error.code === -1125) { // ListenKey does not exist
            addLog("Listen Key không còn hợp lệ, cố gắng lấy cái mới.", true);
            if (userDataWs) { userDataWs.close(); userDataWs = null; }
            if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
            const newListenKey = await getListenKey();
            if (newListenKey) {
                setupUserDataStream(newListenKey);
                listenKey = newListenKey;
            } else {
                addLog("Không thể lấy Listen Key mới, User Data Stream sẽ không hoạt động.", true);
            }
        }
        if (error instanceof CriticalApiError) throw error;
    }
}

function setupUserDataStream(key) {
    if (userDataWs) {
        addLog('Đã có User Data Stream. Đóng kết nối cũ.');
        userDataWs.close();
    }

    const wsUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}?listenKey=${key}`;
    userDataWs = new WebSocket(wsUrl);

    userDataWs.onopen = () => {
        addLog('Kết nối User Data Stream đã mở.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(() => keepAliveListenKey(key), 1000 * 60 * 30); // Refresh every 30 minutes
    };

    userDataWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.e === 'ORDER_TRADE_UPDATE') {
            processTradeResult(message.o);
        }
    };

    userDataWs.onerror = (error) => {
        addLog(`Lỗi User Data Stream: ${error.message || error}`, true);
        if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    };

    userDataWs.onclose = (event) => {
        addLog(`User Data Stream đã đóng. Mã: ${event.code}, Lý do: ${event.reason || 'Không rõ'}`, true);
        if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
        userDataWs = null;
        if (botRunning) {
            addLog("Đang thử kết nối lại User Data Stream sau 5 giây...", true);
            setTimeout(async () => {
                if (!botRunning) return;
                const newKey = await getListenKey();
                if (newKey) {
                    setupUserDataStream(newKey);
                    listenKey = newKey;
                } else {
                    addLog("Không thể khôi phục User Data Stream. Có thể mất cập nhật.", true);
                }
            }, 5000);
        }
    };
}

function setupMarketDataStream(symbol) {
    if (marketWs) {
        addLog('Đã có Market Data Stream. Đóng kết nối cũ.');
        marketWs.close();
    }

    const wsUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice`;
    marketWs = new WebSocket(wsUrl);

    marketWs.onopen = () => {
        addLog('Kết nối Market Data Stream đã mở.');
    };

    marketWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.e === 'markPriceUpdate') {
            currentMarketPrice = parseFloat(message.p);
             if (currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice;
             if (currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice;
        }
    };

    marketWs.onerror = (error) => {
        addLog(`Lỗi Market Data Stream: ${error.message || error}`, true);
    };

    marketWs.onclose = (event) => {
        addLog(`Market Data Stream đã đóng. Mã: ${event.code}, Lý do: ${event.reason || 'Không rõ'}`, true);
        marketWs = null;
        if (botRunning) {
            addLog("Đang thử kết nối lại Market Data Stream sau 5 giây...", true);
            setTimeout(() => {
                if (!botRunning) return;
                setupMarketDataStream(symbol);
            }, 5000);
        }
    };
}


async function startBotLogicInternal() {
    if (botRunning) { return 'Bot đang chạy.'; }
    if (!API_KEY || !SECRET_KEY) { addLog('Thiếu API Key/Secret. Không thể khởi động.', true); stopBotLogicInternal(); return 'Thiếu API Key hoặc Secret.'; }
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; addLog('Hủy lịch tự động thử lại.', true); }

    addLog('--- Đang khởi động Bot ---', true);
    try {
        await syncServerTime();
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`API Key OK! USDT khả dụng: ${usdtAsset.toFixed(2)}.`, true); consecutiveApiErrors = 0;

        await getExchangeInfo();
        if (!exchangeInfoCache || !exchangeInfoCache[TARGET_COIN_SYMBOL]) { throw new CriticalApiError(`Không tải thông tin sàn cho ${TARGET_COIN_SYMBOL}. Bot dừng.`); }
         addLog(`Đã tải thông tin sàn.`);


        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);
        currentLongPosition = null; currentShortPosition = null;

        if (positionsOnBinance.length > 0) {
            addLog(`Tìm thấy ${positionsOnBinance.length} vị thế đang mở cho ${TARGET_COIN_SYMBOL} trên sàn. Thử khôi phục trạng thái.`, true);
            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) throw new CriticalApiError("Không lấy được đòn bẩy khi khôi phục.");

             let partialCloseSteps = [];
             if (maxLeverage >= 75) { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 100); } else if (maxLeverage === 50) { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 50); } else if (maxLeverage <= 25) { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 35); } else { for (let i = 1; i <= 8; i++) partialCloseSteps.push(i * 350); }


             const openOrdersOnBinance = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: TARGET_COIN_SYMBOL });


            for (const pos of positionsOnBinance) {
                 if (pos.symbol !== TARGET_COIN_SYMBOL) continue;
                 const symbolInfo = exchangeInfoCache[TARGET_COIN_SYMBOL];
                 const pricePrecision = symbolInfo?.pricePrecision || 8;

                const recoveredPosition = {
                    symbol: TARGET_COIN_SYMBOL, quantity: Math.abs(parseFloat(pos.positionAmt)), initialQuantity: Math.abs(parseFloat(pos.positionAmt)),
                    entryPrice: parseFloat(pos.entryPrice), initialTPPrice: 0, initialSLPrice: 0, initialMargin: INITIAL_INVESTMENT_AMOUNT,
                    openTime: new Date(parseFloat(pos.updateTime || Date.now())), pricePrecision, side: pos.positionSide,
                    unrealizedPnl: parseFloat(pos.unRealizedProfit), currentPrice: parseFloat(pos.markPrice), currentTPId: null, currentSLId: null,
                    partialCloseLossLevels: partialCloseSteps, nextPartialCloseLossIndex: 0,
                    closedQuantity: 0, partialClosePrices: [], hasRemovedInitialSL: false,
                    hasAdjustedSL6thClose: false, hasAdjustedSL8thClose: false, maxLeverageUsed: maxLeverage,
                };

                const relatedOrders = openOrdersOnBinance.filter(o => o.positionSide === pos.positionSide && o.status === 'NEW' && o.symbol === TARGET_COIN_SYMBOL);
                 for (const order of relatedOrders) {
                     if (order.type === 'TAKE_PROFIT_MARKET') { recoveredPosition.currentTPId = order.orderId; recoveredPosition.initialTPPrice = parseFloat(order.stopPrice); addLog(`Khôi phục lệnh TP ${order.orderId} cho ${pos.positionSide}.`); }
                     else if (order.type === 'STOP_MARKET') { recoveredPosition.currentSLId = order.orderId; recoveredPosition.initialSLPrice = parseFloat(order.stopPrice); addLog(`Khôi phục lệnh SL ${order.orderId} cho ${pos.positionSide}.`); }
                 }

                 if (recoveredPosition.side === 'LONG' && recoveredPosition.maxLeverageUsed >= 75 && !recoveredPosition.currentSLId) recoveredPosition.hasRemovedInitialSL = true;

                if (pos.positionSide === 'LONG' && parseFloat(pos.positionAmt) > 0) currentLongPosition = recoveredPosition;
                else if (pos.positionSide === 'SHORT' && parseFloat(pos.positionAmt) < 0) currentShortPosition = recoveredPosition;
            }

            if (!currentLongPosition && !currentShortPosition) addLog(`Vị thế trên sàn có thể đã đóng. Sẽ bắt đầu chu kỳ mở lệnh mới.`, true);
             else addLog(`Đã khôi phục trạng thái vị thế. Bot sẽ theo dõi và quản lý.`, true);

        } else addLog(`Không tìm thấy vị thế đang mở cho ${TARGET_COIN_SYMBOL} trên sàn.`, true);

        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey);
        else addLog("Không thể kết nối User Data Stream. Cập nhật có thể bị trễ.", true);

        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy ---`, true);
        addLog(`Đồng coin: ${TARGET_COIN_SYMBOL} | Vốn ban đầu mỗi lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT.`, true);

        scheduleNextMainCycle();

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog(`[Lỗi Khởi động] ${errorMsg}`, true);
        addLog(`Bot dừng. Kiểm tra log.`, true);
        stopBotLogicInternal();
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`Lên lịch tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
            retryBotTimeout = setTimeout(async () => {
                addLog('Đang thử lại khởi động...', true);
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Khởi động thất bại: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    botRunning = false; addLog('--- Đang dừng Bot ---', true);
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    if (marketWs) { marketWs.close(); marketWs = null; }
    if (userDataWs) { userDataWs.close(); userDataWs = null; }
    if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    listenKey = null; currentMarketPrice = null;
    consecutiveApiErrors = 0;
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; addLog('Đã hủy lịch thử lại tự động.', true); }
    addLog('--- Bot đã dừng ---', true);
    botStartTime = null;
    currentLongPosition = null; currentShortPosition = null;
    totalProfit = 0; totalLoss = 0; netPNL = 0; isClosingPosition = false;
    return 'Bot đã dừng.';
}

async function cleanupAndResetCycle_Internal(symbol) {
    if (!botRunning) return;
    addLog(`Bắt đầu dọn dẹp cho chu kỳ mới (${symbol}).`, true);

    try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positionsOnBinanceRaw.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remainingPositions.length > 0) {
            addLog(`Dọn dẹp: Phát hiện ${remainingPositions.length} vị thế sót lại trên sàn. Buộc đóng.`, true);
            for (const pos of remainingPositions) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                 closePosition(pos.symbol, Math.abs(parseFloat(pos.positionAmt)), `Vị thế sót trong dọn dẹp`, sideToClose)
                 .catch(err => { addLog(`Dọn dẹp: Lỗi đóng vị thế sót ${pos.symbol} (${sideToClose}): ${err.message}`, true); if (err instanceof CriticalApiError) stopBotLogicInternal(); });
            }
            return;
        } else { addLog(`Dọn dẹp: Không có vị thế sót lại.`); }
    } catch (error) { addLog(`Dọn dọn: Lỗi kiểm tra vị thế sót: ${error.message}`, true); if (error instanceof CriticalApiError) { stopBotLogicInternal(); return; } }

    try { await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); } catch (error) { addLog(`Dọn dẹp: Lỗi hủy lệnh chờ: ${error.message}`, true); }

    currentLongPosition = null; currentShortPosition = null;
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; addLog('Dọn dẹp: Đã dừng kiểm tra định kỳ.'); }

    if (botRunning) { addLog(`Dọn dẹp hoàn tất. Lên lịch chu kỳ mới.`, true); scheduleNextMainCycle(); }
    else { addLog(`Dọn dẹp hoàn tất. Bot không chạy.`, true); }
}

const app = express();
app.use(express.json());
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, customLogData) => {
        if (!err && customLogData && customLogData.trim().length > 0) res.send(customLogData.split('\n').slice(Math.max(0, customLogData.split('\n').length - 500)).join('\n'));
        else fs.readFile(BOT_LOG_FILE, 'utf8', (err, pm2LogData) => { if (err) return res.status(404).send(`Không tìm thấy file log: ${BOT_LOG_FILE}`); const cleanData = pm2LogData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(cleanData.split('\n').slice(Math.max(0, cleanData.split('\n').length - 500)).join('\n')); });
    });
});
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((r, j) => { exec('pm2 jlist', (e, out) => { if (e) return j(e); try { r(JSON.parse(out)); } catch (err) { j(err); } }); });
        const botProcess = pm2List.find(p => p.name === THIS_BOT_PM2_NAME);
        let status = { pm2Status: 'Không tìm thấy', internalBotStatus: 'Dừng', configuredSymbol: TARGET_COIN_SYMBOL, configuredInitialCapital: INITIAL_INVESTMENT_AMOUNT, uptimeMinutes: 0, restartCount: 0, openPositions: { long: !!currentLongPosition, short: !!currentShortPosition }, liveStatus: "Chưa chạy" };
        if (botProcess) {
            status.pm2Status = botProcess.pm2_env.status?.toUpperCase() || 'Không rõ'; status.restartCount = botProcess.pm2_env.restart_time || 0;
            if (botProcess.pm2_env.pm_uptime) status.uptimeMinutes = Math.floor((Date.now() - botProcess.pm2_env.pm_uptime) / (1000 * 60));
            if (botProcess.pm2_env.status === 'online') { status.internalBotStatus = botRunning ? 'Đang chạy' : 'Đã dừng (nội bộ)'; if (botRunning) { if (botStartTime) status.uptimeMinutes = Math.floor((Date.now() - botStartTime.getTime()) / (1000 * 60)); status.liveStatus = `OK | WS: MKT=${marketWs?'ON':'OFF'}, UD=${userDataWs?'ON':'OFF'} | Lỗi API:${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}`; } else status.liveStatus = `Đã dừng`; }
            else status.liveStatus = `Trạng thái PM2: ${status.pm2Status}`;
        }
        res.json(status);
    } catch (error) { console.error('Lỗi lấy trạng thái:', error); res.status(500).json({ success: false, message: 'Lỗi lấy trạng thái bot.' }); }
});

app.get('/api/bot_stats', async (req, res) => {
    try {
        const livePositionsOnBinanceRaw = botRunning ? await callSignedAPI('/fapi/v2/positionRisk', 'GET').catch(e => { addLog(`Lỗi lấy vị thế live cho thống kê: ${e.message}`, true); return []; }) : [];
        const livePositionsOnBinance = livePositionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);
        let openPositionsData = [];
        const positionsToCheck = [currentLongPosition, currentShortPosition];
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
                initialMargin: localPos.initialMargin, partialCloseLossLevels: localPos.partialCloseLossLevels, nextPartialCloseLossIndex: localPos.nextPartialCloseLossIndex,
                closedQuantity: localPos.closedQuantity, partialClosePrices: localPos.partialClosePrices,
                hasRemovedInitialSL: localPos.hasRemovedInitialSL, hasAdjustedSL6thClose: localPos.hasAdjustedSL6thClose, hasAdjustedSL8thClose: localPos.hasAdjustedSL8thClose,
                 currentProfitPercentage: localPos.initialMargin > 0 ? ((livePos ? parseFloat(livePos.unRealizedProfit) : localPos.unrealizedPnl) / localPos.initialMargin) * 100 : 0
            });
        }
        res.json({ success: true, data: { totalProfit, totalLoss, netPNL, currentOpenPositions: openPositionsData, currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT, botRunning, targetSymbol: TARGET_COIN_SYMBOL, }, });
    } catch (error) { console.error('Lỗi lấy thống kê:', error); res.status(500).json({ success: false, message: 'Lỗi lấy thống kê bot.' }); }
});
app.post('/api/configure', (req, res) => {
    const { coinConfigs } = req.body;
    if (!coinConfigs?.[0]?.symbol || typeof coinConfigs[0].initialAmount === 'undefined') { const msg = "Dữ liệu cấu hình không hợp lệ hoặc thiếu."; addLog(msg, true); return res.status(400).json({ success: false, message: msg }); }
    if (botRunning) { const msg = 'Dừng bot trước khi cấu hình lại.'; addLog(`Từ chối cấu hình: Bot đang chạy.`, true); return res.status(409).json({ success: false, message: msg }); }

    const config = coinConfigs[0]; const oldTargetCoinSymbol = TARGET_COIN_SYMBOL; const newTargetCoinSymbol = config.symbol.trim().toUpperCase(); const newInitialAmount = parseFloat(config.initialAmount);
    if (isNaN(newInitialAmount) || newInitialAmount <= 0) { const msg = `Số vốn ban đầu ${config.initialAmount} không hợp lệ.`; addLog(msg, true); return res.status(400).json({ success: false, message: msg }); }
    TARGET_COIN_SYMBOL = newTargetCoinSymbol; INITIAL_INVESTMENT_AMOUNT = newInitialAmount;
    if (oldTargetCoinSymbol !== TARGET_COIN_SYMBOL) {
        addLog(`Đã đổi đồng coin mục tiêu từ ${oldTargetCoinSymbol} sang ${TARGET_COIN_SYMBOL}. Reset trạng thái.`, true);
        currentLongPosition = null; currentShortPosition = null; totalProfit = 0; totalLoss = 0; netPNL = 0; exchangeInfoCache = null; isClosingPosition = false;
    } else { addLog(`Đã cập nhật cấu hình cho đồng coin hiện tại ${TARGET_COIN_SYMBOL}.`, true); }
    addLog(`Đã cập nhật cấu hình. Đồng coin: ${TARGET_COIN_SYMBOL}, Vốn/lệnh: ${INITIAL_INVESTMENT_AMOUNT}. Khởi động lại bot để áp dụng.`, true);
    res.json({ success: true, message: 'Đã cập nhật cấu hình.' });
});
app.get('/start_bot_logic', async (req, res) => {
     try {
        const message = await startBotLogicInternal();
        res.json({ success: botRunning, message, botRunning });
     } catch (error) { console.error('Lỗi bất ngờ khi gọi startBotLogic:', error); res.status(500).json({ success: false, message: `Lỗi bất ngờ khi khởi động: ${error.message}`, botRunning: botRunning }); }
});
app.get('/stop_bot_logic', (req, res) => {
     try {
        const message = stopBotLogicInternal();
        res.json({ success: !botRunning, message, botRunning });
     } catch (error) { console.error('Lỗi khi gọi stopBotLogic:', error); res.status(500).json({ success: false, message: `Lỗi khi dừng bot: ${error.message}`, botRunning: botRunning }); }
});

app.listen(WEB_SERVER_PORT, () => { addLog(`Web server đang chạy trên cổng ${WEB_SERVER_PORT}.`, true); });
