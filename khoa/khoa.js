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

const WEB_SERVER_PORT = 6789;
const THIS_BOT_PM2_NAME = 'khoa';
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
            }
        }
        return 0;
    } catch (e) {
        addLog(`Lỗi khi lấy dữ liệu biến động 1h: ${e.message}`);
        if (e instanceof CriticalApiError) throw e;
        return 0;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const bracket = r.find(i => i.symbol === symbol)?.brackets[0]; return bracket ? parseInt(bracket.initialLeverage) : null; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize || 0.001), stepSize: parseFloat(l?.stepSize || 0.001), minNotional: parseFloat(m?.notional || 0) }; }); return exchangeInfoCache; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }

async function cancelAllOpenOrdersForSymbol(symbol) {
    addLog(`Hủy TẤT CẢ lệnh chờ cho ${symbol}...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) return;
        for (const order of openOrders) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId });
                await sleep(50);
            } catch (innerError) {
                 if (innerError.code !== -2011) addLog(`Lỗi hủy lệnh ${order.orderId}: ${innerError.msg || innerError.message}`);
                 if (innerError instanceof CriticalApiError) stopBotLogicInternal();
            }
        }
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
             addLog(`Vị thế LÃI (${closedPositionSide}) đã đóng. Đóng vị thế LỖ đối ứng (nếu còn).`);
             if (remainingPosition && remainingPosition.quantity > 0) {
                 try {
                     const positionsOnExchange = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol });
                     const currentLosingQtyOnExchange = Math.abs(parseFloat(positionsOnExchange.find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side)?.positionAmt || 0));
                     if (currentLosingQtyOnExchange > 0) {
                          await closePosition(remainingPosition.symbol, `Lệnh LÃI đối ứng (${closedPositionSide}) đã chốt`, remainingPosition.side);
                     }
                 } catch(e) {
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

async function closePosition(symbol, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;
    isProcessingTrade = true;
    addLog(`Đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (posOnBinance) {
            const qtyToCloseMarket = Math.abs(parseFloat(posOnBinance.positionAmt));
            if (qtyToCloseMarket === 0) { isProcessingTrade = false; return false; }
            const closeSideOrder = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSideOrder, positionSide, type: 'MARKET', quantity: qtyToCloseMarket });
            
            if (positionSide === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
            else if (positionSide === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;
            
            isProcessingTrade = false; return true;
        } else {
            isProcessingTrade = false; return false;
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
         if (error instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false; return false;
    }
}

async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    addLog(`Mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Lỗi đặt đòn bẩy.");
        await sleep(200);
        
        const priceToUseForCalc = entryPriceOverride || await getCurrentPrice(symbol);
        if (!priceToUseForCalc) throw new Error("Lỗi lấy giá hiện tại/giá ghi đè.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceToUseForCalc;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantity * priceToUseForCalc < symbolDetails.minNotional) {
             throw new Error("Giá trị lệnh quá nhỏ so với sàn.");
        }
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity,
        });

        let openPos = null;
        for(let i = 0; i < 15; i++) {
            await sleep(400);
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) >= quantity * 0.95);
            if (openPos && Math.abs(parseFloat(openPos.positionAmt)) > 0) break;
        }
        if (!openPos || Math.abs(parseFloat(openPos.positionAmt)) === 0) {
            throw new Error("Vị thế chưa xác nhận trên sàn sau nhiều lần thử.");
        }
        const actualEntryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | KL: ${actualQuantity.toFixed(symbolDetails.quantityPrecision)} | Giá vào thực tế: ${actualEntryPrice.toFixed(symbolDetails.pricePrecision)}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, 
            entryPrice: actualEntryPrice, 
            initialMargin: INITIAL_INVESTMENT_AMOUNT,
            side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: symbolDetails.pricePrecision,
            quantityPrecision: symbolDetails.quantityPrecision,
            closedLossAmount: 0,
            nextPartialCloseLossIndex: 0,
            pnlBaseForNextMoc: 0,
            hasAdjustedSLToSpecificLevel: {},
            hasClosedAllLossPositionAtLastLevel: false,
            pairEntryPrice: priceToUseForCalc, 
        };
    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return null;
    }
}

async function setTPAndSLForPosition(position, isFullResetEvent = false) {
    if (!position || position.quantity <= 0) return false;
    const symbolDetails = await getSymbolDetails(position.symbol);
    if(!symbolDetails) { addLog("Không có symbolDetails để đặt TP/SL"); return false;}


    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity, pnlBaseForNextMoc = 0 } = position;
    addLog(`Đặt/Reset TP/SL cho ${side} (Entry: ${entryPrice.toFixed(pricePrecision)}, KL: ${quantity.toFixed(position.quantityPrecision)}, PNL Cơ Sở: ${pnlBaseForNextMoc.toFixed(2)}%)...`);

    try {
        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
        if (maxLeverageUsed >= 75) { TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = 6; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); }
        else if (maxLeverageUsed >= 50) { TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = 3; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); }
        else { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 2; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); }

        const pnlBaseInUSDT = (initialMargin * pnlBaseForNextMoc) / 100;
        const targetPnlForTP_USDT = (initialMargin * TAKE_PROFIT_MULTIPLIER) + pnlBaseInUSDT;
        const targetPnlForSL_USDT = -(initialMargin * STOP_LOSS_MULTIPLIER) + pnlBaseInUSDT;
        
        const priceChangeUnitForTP = targetPnlForTP_USDT / initialQuantity; 
        const priceChangeUnitForSL = Math.abs(targetPnlForSL_USDT) / initialQuantity; 

        let tpPrice = parseFloat((side === 'LONG' ? entryPrice + priceChangeUnitForTP : entryPrice - priceChangeUnitForTP).toFixed(pricePrecision));
        let slPrice = parseFloat((side === 'LONG' ? entryPrice - priceChangeUnitForSL : entryPrice + priceChangeUnitForSL).toFixed(pricePrecision));
        
        if (side === 'LONG') {
            if (slPrice >= tpPrice && tpPrice > entryPrice) slPrice = parseFloat((tpPrice - symbolDetails.tickSize).toFixed(pricePrecision));
            else if (slPrice >= entryPrice && targetPnlForSL_USDT < 0) slPrice = parseFloat((entryPrice - symbolDetails.tickSize).toFixed(pricePrecision));
            if (tpPrice <= entryPrice && targetPnlForTP_USDT > 0) tpPrice = parseFloat((entryPrice + symbolDetails.tickSize).toFixed(pricePrecision));
        } else { 
            if (slPrice <= tpPrice && tpPrice < entryPrice) slPrice = parseFloat((tpPrice + symbolDetails.tickSize).toFixed(pricePrecision));
            else if (slPrice <= entryPrice && targetPnlForSL_USDT < 0) slPrice = parseFloat((entryPrice + symbolDetails.tickSize).toFixed(pricePrecision));
            if (tpPrice >= entryPrice && targetPnlForTP_USDT > 0) tpPrice = parseFloat((entryPrice - symbolDetails.tickSize).toFixed(pricePrecision));
        }

        const orderSidePlace = (side === 'LONG') ? 'SELL' : 'BUY';
        if (quantity <= 0) return false;

        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSidePlace, positionSide: side, type: 'STOP_MARKET',
            stopPrice: slPrice, quantity, timeInForce: 'GTC', newClientOrderId: `SL-${side}-${Date.now()}`
        });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSidePlace, positionSide: side, type: 'TAKE_PROFIT_MARKET',
            stopPrice: tpPrice, quantity, timeInForce: 'GTC', newClientOrderId: `TP-${side}-${Date.now()}`
        });

        addLog(`TP/SL cho ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)}`);
        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        if (!position.partialCloseLossLevels || position.partialCloseLossLevels.length === 0) position.partialCloseLossLevels = partialCloseLossSteps;

        if (isFullResetEvent) {
            position.nextPartialCloseLossIndex = 0;
            position.hasAdjustedSLToSpecificLevel = {};
            position.hasClosedAllLossPositionAtLastLevel = false;
        }
        if (typeof position.pnlBaseForNextMoc !== 'number') position.pnlBaseForNextMoc = 0;
        return true;
    } catch (error) {
        addLog(`Lỗi đặt TP/SL cho ${side}: ${error.msg || error.message}.`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return false;
    }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        let currentQtyInBot = position.quantity;
        if (currentQtyInBot === 0) { isProcessingTrade = false; return false; }
        let effectiveQuantityToClose = Math.min(quantityToClose, currentQtyInBot);
        effectiveQuantityToClose = parseFloat((Math.floor(effectiveQuantityToClose / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (effectiveQuantityToClose <= 0) { isProcessingTrade = false; return false; }
        
        const orderSide = (position.side === 'LONG') ? 'SELL' : 'BUY';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol, side: orderSide, positionSide: position.side,
            type: 'MARKET', quantity: effectiveQuantityToClose,
            newClientOrderId: `PARTIAL-CLOSE-${position.side}-${Date.now()}`
        });
        position.closedLossAmount += effectiveQuantityToClose;
        position.quantity -= effectiveQuantityToClose;
        if (position.quantity < 0) position.quantity = 0;
        addLog(`Đóng ${effectiveQuantityToClose.toFixed(symbolDetails.quantityPrecision)} ${position.side}. Còn lại: ${position.quantity.toFixed(symbolDetails.quantityPrecision)}. Đã đóng lỗ: ${position.closedLossAmount.toFixed(symbolDetails.quantityPrecision)}`);
        isProcessingTrade = false; return true;
    } catch (error) {
        addLog(`Lỗi đóng từng phần ${position.side}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade) isProcessingTrade = false; }
}

async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!positionToModify || quantityToAdd <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;
    try {
        const symbolDetails = await getSymbolDetails(positionToModify.symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        
        let effectiveQuantityToAdd = quantityToAdd;
        if (reasonForAdd !== "kill_mode_reopen_closed_losing_pos") { 
            const currentQtyInBot = positionToModify.quantity;
            const maxQtyAllowedToReachInitial = Math.max(0, positionToModify.initialQuantity - currentQtyInBot); 
            
            if (maxQtyAllowedToReachInitial <= 0 && reasonForAdd !== "kill_to_sideways_reopen_losing") { 
                addLog(`Không cần mở thêm cho ${positionToModify.side}, đã đủ hoặc vượt KL ban đầu. KL hiện tại: ${currentQtyInBot}, KL ban đầu: ${positionToModify.initialQuantity}`);
                isProcessingTrade = false; 
                return false; 
            }
            effectiveQuantityToAdd = Math.min(effectiveQuantityToAdd, maxQtyAllowedToReachInitial);

             if (reasonForAdd === "kill_to_sideways_reopen_losing") { 
                effectiveQuantityToAdd = Math.max(0, positionToModify.initialQuantity - currentQtyInBot);
            }
        }
        
        effectiveQuantityToAdd = parseFloat((Math.floor(effectiveQuantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (effectiveQuantityToAdd <= 0) { 
            addLog(`KL hiệu dụng để mở thêm cho ${positionToModify.side} là 0 hoặc âm. Hủy bỏ.`);
            isProcessingTrade = false; 
            return false; 
        }
        
        const orderSide = (positionToModify.side === 'LONG') ? 'BUY' : 'SELL';
        addLog(`Mở thêm ${effectiveQuantityToAdd.toFixed(symbolDetails.quantityPrecision)} ${positionToModify.symbol} cho ${positionToModify.side} (Lý do: ${reasonForAdd}).`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: positionToModify.symbol, side: orderSide, positionSide: positionToModify.side,
            type: 'MARKET', quantity: effectiveQuantityToAdd,
             newClientOrderId: `ADD-POS-${positionToModify.side}-${Date.now()}`
        });
        
        positionToModify.closedLossAmount -= effectiveQuantityToAdd;
        if (positionToModify.closedLossAmount < 0) positionToModify.closedLossAmount = 0;
        
        addLog(`Hủy tất cả lệnh chờ của ${TARGET_COIN_SYMBOL} và đặt lại TP/SL mới.`);
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        await sleep(500);
        
        const otherPos = (positionToModify.side === 'LONG') ? currentShortPosition : currentLongPosition;

        if (reasonForAdd === "sideways_moc5_reopen" && otherPos) {
            addLog(`Lệnh thắng ${otherPos.side} tại Mốc 5 Sideways. PNL cơ sở mới: ${((otherPos.unrealizedPnl / otherPos.initialMargin) * 100).toFixed(2)}%. Mốc reset về 1.`);
            otherPos.pnlBaseForNextMoc = (otherPos.unrealizedPnl / otherPos.initialMargin) * 100; 
            otherPos.nextPartialCloseLossIndex = 0; 
            otherPos.hasAdjustedSLToSpecificLevel = {}; 

            addLog(`Lệnh lỗ ${positionToModify.side} được mở lại ở Mốc 5 Sideways. PNL cơ sở reset về 0, mốc về 1.`);
            positionToModify.pnlBaseForNextMoc = 0;
            positionToModify.nextPartialCloseLossIndex = 0;

        } else if (reasonForAdd === "price_near_pair_entry_reopen") {
            // ---> MODIFICATION STARTS HERE
            addLog(`Lệnh ${positionToModify.side} mở lại khi giá về entry. PNL cơ sở của nó reset về 0, mốc về 1.`);
            positionToModify.pnlBaseForNextMoc = 0;
            positionToModify.nextPartialCloseLossIndex = 0;
            
            if (otherPos) {
                // Nếu PNL cơ sở của otherPos vẫn là 0 (hoặc rất gần 0) VÀ nó đang ở Mốc 1 (chưa qua mốc nào đáng kể)
                // thì reset cả otherPos. Nếu không, giữ nguyên PNL cơ sở và mốc của otherPos.
                if ( (otherPos.pnlBaseForNextMoc === 0 || Math.abs(otherPos.pnlBaseForNextMoc) < 0.01) && otherPos.nextPartialCloseLossIndex === 0) {
                     addLog(`Do giá về entry VÀ lệnh đối ứng ${otherPos.side} chưa có PNL cơ sở đáng kể (PNLb: ${(otherPos.pnlBaseForNextMoc || 0).toFixed(2)}%, Mốc: ${(otherPos.nextPartialCloseLossIndex || 0) + 1}), PNL cơ sở của nó cũng reset về 0, mốc về 1.`);
                     otherPos.pnlBaseForNextMoc = 0;
                     otherPos.nextPartialCloseLossIndex = 0;
                } else {
                    addLog(`Do giá về entry, lệnh đối ứng ${otherPos.side} GIỮ NGUYÊN PNL cơ sở đã tích lũy (${(otherPos.pnlBaseForNextMoc || 0).toFixed(2)}%) và mốc (${(otherPos.nextPartialCloseLossIndex || 0) + 1}).`);
                }
            }
            // ---> MODIFICATION ENDS HERE
        } else if (reasonForAdd === "kill_mode_reopen_closed_losing_pos") {
             addLog(`Mở mới hoàn toàn lệnh lỗ ${positionToModify.side} trong Kill mode. Lệnh này PNL cơ sở 0, mốc 1.`);
             positionToModify.pnlBaseForNextMoc = 0; 
             positionToModify.nextPartialCloseLossIndex = 0;
             if (otherPos) { 
                addLog(`Lệnh thắng đối ứng ${otherPos.side} trong Kill mode reopen, PNL cơ sở mới là PNL hiện tại: ${((otherPos.unrealizedPnl / otherPos.initialMargin) * 100).toFixed(2)}%. Mốc reset về 1.`);
                otherPos.pnlBaseForNextMoc = (otherPos.unrealizedPnl / otherPos.initialMargin) * 100;
                otherPos.nextPartialCloseLossIndex = 0;
                otherPos.hasAdjustedSLToSpecificLevel = {};
             }
        } else if (reasonForAdd === "kill_to_sideways_reopen_losing") {
            addLog(`Chuyển từ Kill sang Sideways. Lệnh lỗ ${positionToModify.side} được mở lại. PNL cơ sở của nó là 0, mốc 1.`);
            positionToModify.pnlBaseForNextMoc = 0;
            positionToModify.nextPartialCloseLossIndex = 0;
            if (otherPos) {
                 addLog(`Lệnh thắng ${otherPos.side} trong quá trình chuyển Kill->Sideways giữ PNL cơ sở là ${otherPos.pnlBaseForNextMoc.toFixed(2)}% và mốc ${otherPos.nextPartialCloseLossIndex + 1}.`);
            }
        }

        const newPairEntryPrice = await getCurrentPrice(TARGET_COIN_SYMBOL); 
        if (newPairEntryPrice) {
            if (currentLongPosition) {
                currentLongPosition.pairEntryPrice = newPairEntryPrice;
                addLog(`Giá cặp mới cho LONG: ${currentLongPosition.pairEntryPrice.toFixed(currentLongPosition.pricePrecision || 5)}`);
            }
            if (currentShortPosition) {
                currentShortPosition.pairEntryPrice = newPairEntryPrice;
                 addLog(`Giá cặp mới cho SHORT: ${currentShortPosition.pairEntryPrice.toFixed(currentShortPosition.pricePrecision || 5)}`);
            }
        }
        addLog("Đợi khớp lệnh và cập nhật vị thế từ sàn...");
        await sleep(2000); 

        const updatedPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        if (currentLongPosition) {
            const lpOnEx = updatedPositions.find(p => p.symbol === currentLongPosition.symbol && p.positionSide === currentLongPosition.side);
            if (lpOnEx) {
                currentLongPosition.quantity = Math.abs(parseFloat(lpOnEx.positionAmt));
                currentLongPosition.entryPrice = parseFloat(lpOnEx.entryPrice); 
            } else { 
                addLog(`CẢNH BÁO: Không tìm thấy vị thế LONG ${TARGET_COIN_SYMBOL} trên sàn sau khi addPosition.`);
                currentLongPosition.quantity = 0; 
            }
        }
        if (currentShortPosition) {
            const spOnEx = updatedPositions.find(p => p.symbol === currentShortPosition.symbol && p.positionSide === currentShortPosition.side);
            if (spOnEx) {
                currentShortPosition.quantity = Math.abs(parseFloat(spOnEx.positionAmt));
                currentShortPosition.entryPrice = parseFloat(spOnEx.entryPrice); 
            } else {
                addLog(`CẢNH BÁO: Không tìm thấy vị thế SHORT ${TARGET_COIN_SYMBOL} trên sàn sau khi addPosition.`);
                currentShortPosition.quantity = 0;
            }
        }

        let tpslSuccess = true;
        if (currentLongPosition && currentLongPosition.quantity > 0) {
            if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslSuccess = false; 
            await sleep(300);
        }
        if (currentShortPosition && currentShortPosition.quantity > 0) {
            if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslSuccess = false; 
        }
        if (!tpslSuccess) addLog("Lỗi đặt lại TP/SL sau khi mở lại lệnh.");
        
        isProcessingTrade = false; return true;
    } catch (error) {
        addLog(`Lỗi mở lại lệnh ${positionToModify?.side || 'UNKNOWN'}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade) isProcessingTrade = false; }
}

async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;
    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const vol = await getHourlyVolatility(TARGET_COIN_SYMBOL);
        currentBotMode = (vol <= 5) ? 'sideways' : 'kill';
        addLog(`Chế độ ${currentBotMode.toUpperCase()} kích hoạt (Biến động 1h: ${vol.toFixed(2)}%)`);

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) { if (botRunning) scheduleNextMainCycle(); return; }
        
        const priceForNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL); 
        if (!priceForNewPair) { if (botRunning) scheduleNextMainCycle(); return; }

        currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLeverage, priceForNewPair);
        if (!currentLongPosition) { if (botRunning) scheduleNextMainCycle(); return; }
        
        await sleep(800);
        currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLeverage, priceForNewPair);
        if (!currentShortPosition) {
            if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT', 'LONG');
            currentLongPosition = null; if (botRunning) scheduleNextMainCycle(); return;
        }
        
        await sleep(1000);
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        await sleep(500);

        let tpslAllSet = true;
        if (currentLongPosition && currentLongPosition.quantity > 0) {
            if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslAllSet = false; 
        }
        await sleep(300);
        if (currentShortPosition && currentShortPosition.quantity > 0) {
             if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslAllSet = false; 
        }

        if (!tpslAllSet) {
             addLog("Đặt TP/SL ban đầu thất bại. Đang đóng cả hai.");
             if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi đặt TP/SL', 'LONG');
             if (currentShortPosition) await closePosition(currentShortPosition.symbol, 'Lỗi đặt TP/SL', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return;
        }

        if (!positionCheckInterval) {
             positionCheckInterval = setInterval(async () => {
                 if (botRunning && (currentLongPosition || currentShortPosition)) {
                     try { await manageOpenPosition(); }
                     catch (error) { if(error instanceof CriticalApiError) stopBotLogicInternal(); }
                 } else if (!botRunning && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
             }, 7000); 
        }
    } catch (error) { if(error instanceof CriticalApiError) stopBotLogicInternal(); if(botRunning) scheduleNextMainCycle(); }
}

const manageOpenPosition = async () => {
    if (!currentLongPosition || !currentShortPosition) {
        if (!currentLongPosition && !currentShortPosition && botRunning) {
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
        }
        return;
    }
    if (isProcessingTrade) return;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        let longPosOnExchange = positions.find(p => p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0);
        let shortPosOnExchange = positions.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!longPosOnExchange && currentLongPosition) { addLog(`Vị thế LONG ${TARGET_COIN_SYMBOL} không còn trên sàn. Cập nhật bot.`); currentLongPosition.quantity = 0; currentLongPosition = null; }
        if (!shortPosOnExchange && currentShortPosition) { addLog(`Vị thế SHORT ${TARGET_COIN_SYMBOL} không còn trên sàn. Cập nhật bot.`); currentShortPosition.quantity = 0; currentShortPosition = null; }
        
        if (!currentLongPosition || !currentShortPosition) { 
             if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
             return;
        }

        if (longPosOnExchange && currentLongPosition) {
            currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
            currentLongPosition.currentPrice = parseFloat(longPosOnExchange.markPrice); 
            currentLongPosition.quantity = Math.abs(parseFloat(longPosOnExchange.positionAmt));
        }
        if (shortPosOnExchange && currentShortPosition) {
            currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
            currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
            currentShortPosition.quantity = Math.abs(parseFloat(shortPosOnExchange.positionAmt));
        }
        
        if (currentMarketPrice !== null) { 
            const referencePairEntryPrice = currentLongPosition?.pairEntryPrice ?? currentShortPosition?.pairEntryPrice;

            if (referencePairEntryPrice !== null) {
                const pricePrecisionForTolerance = currentLongPosition?.pricePrecision ?? currentShortPosition?.pricePrecision ?? 5;
                const tolerance = referencePairEntryPrice * 0.0005; 

                if (Math.abs(currentMarketPrice - referencePairEntryPrice) <= tolerance) {
                    if (currentLongPosition.closedLossAmount > 0 && !currentLongPosition.hasClosedAllLossPositionAtLastLevel && !isProcessingTrade) {
                        addLog(`Giá (${currentMarketPrice.toFixed(pricePrecisionForTolerance)}) về gần pairEntry (${referencePairEntryPrice.toFixed(pricePrecisionForTolerance)}). Mở lại phần đã đóng của LONG.`);
                        if (await addPosition(currentLongPosition, currentLongPosition.closedLossAmount, "price_near_pair_entry_reopen")) {
                            return; 
                        }
                    }

                    if (currentShortPosition.closedLossAmount > 0 && !currentShortPosition.hasClosedAllLossPositionAtLastLevel && !isProcessingTrade) {
                         addLog(`Giá (${currentMarketPrice.toFixed(pricePrecisionForTolerance)}) về gần pairEntry (${referencePairEntryPrice.toFixed(pricePrecisionForTolerance)}). Mở lại phần đã đóng của SHORT.`);
                        if (await addPosition(currentShortPosition, currentShortPosition.closedLossAmount, "price_near_pair_entry_reopen")) {
                            return; 
                        }
                    }
                }
            }
        }
        
        let winningPos = null;
        let losingPos = null;
        if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
        else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
        else { 
            if (currentBotMode === 'kill' && currentLongPosition && currentShortPosition) { 
                const posToCheck = currentLongPosition.unrealizedPnl > currentShortPosition.unrealizedPnl ? currentLongPosition : currentShortPosition; 
                const otherPos = posToCheck === currentLongPosition ? currentShortPosition : currentLongPosition;

                if (otherPos.quantity === 0 && otherPos.hasClosedAllLossPositionAtLastLevel) { 
                    const actualPnlPctPosToCheck = (posToCheck.unrealizedPnl / posToCheck.initialMargin) * 100;
                    const pnlBasePosToCheck = posToCheck.pnlBaseForNextMoc || 0;
                    const PARTIAL_CLOSE_INDEX_5_CHECK = 4; 
                    if (posToCheck.partialCloseLossLevels && posToCheck.partialCloseLossLevels.length > PARTIAL_CLOSE_INDEX_5_CHECK) {
                        const moc5RelativePnl = posToCheck.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5_CHECK];
                        const thresholdReturnToMoc5 = pnlBasePosToCheck + moc5RelativePnl;

                        if (actualPnlPctPosToCheck <= thresholdReturnToMoc5 && posToCheck.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_5_CHECK) { 
                            const vol = await getHourlyVolatility(TARGET_COIN_SYMBOL);
                            if (vol > 5) { 
                                addLog(`[KILL REOPEN] Lệnh thắng ${posToCheck.side} quay về/dưới Mốc 5 (PNL ${actualPnlPctPosToCheck.toFixed(1)}% <= ${thresholdReturnToMoc5.toFixed(1)}%). Mở lại hoàn toàn lệnh lỗ ${otherPos.side}.`);
                                const newMarketPriceForReopen = await getCurrentPrice(TARGET_COIN_SYMBOL);
                                if (!newMarketPriceForReopen) { addLog("Lỗi lấy giá thị trường để mở lại lệnh lỗ trong Kill Reopen."); return; }

                                const reopenedLosingPos = await openMarketPosition(TARGET_COIN_SYMBOL, otherPos.side, otherPos.maxLeverageUsed, newMarketPriceForReopen);
                                if (reopenedLosingPos) {
                                    if (otherPos.side === 'LONG') currentLongPosition = reopenedLosingPos; else currentShortPosition = reopenedLosingPos;
                                    
                                    posToCheck.pnlBaseForNextMoc = actualPnlPctPosToCheck; 
                                    posToCheck.nextPartialCloseLossIndex = 0; 
                                    posToCheck.hasAdjustedSLToSpecificLevel = {};
                                    posToCheck.pairEntryPrice = newMarketPriceForReopen; 
                                    
                                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                                    if (currentLongPosition && currentLongPosition.quantity > 0) await setTPAndSLForPosition(currentLongPosition, true);
                                    await sleep(300);
                                    if (currentShortPosition && currentShortPosition.quantity > 0) await setTPAndSLForPosition(currentShortPosition, true);
                                    return; 
                                }
                            }
                        }
                    }
                }
            }
            return; 
        }


        if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0) {
            const actualPnlPercentageOfWinningPos = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
            const pnlBaseForWinningPos = winningPos.pnlBaseForNextMoc || 0;
            
            if (winningPos.nextPartialCloseLossIndex >= winningPos.partialCloseLossLevels.length) { 
                return;
            }
            const targetMocPnlPercentage_Relative = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            
            const absolutePnlPercentageThresholdForNextMoc = pnlBaseForWinningPos + targetMocPnlPercentage_Relative;

            const PARTIAL_CLOSE_INDEX_5 = 4; 
            const PARTIAL_CLOSE_LEVEL_5_RELATIVE = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5];
            const PARTIAL_CLOSE_INDEX_8 = 7; 
            const PARTIAL_CLOSE_LEVEL_8_RELATIVE = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8];

            let actionTakenAtMoc = false;

            if (actualPnlPercentageOfWinningPos >= absolutePnlPercentageThresholdForNextMoc) {
                actionTakenAtMoc = true;
                let currentHourlyVol = lastHourVolatility; 
                const currentMocIndexReached = winningPos.nextPartialCloseLossIndex;
                addLog(`Lệnh ${winningPos.side} đạt Mốc ${currentMocIndexReached + 1} (PNL ${actualPnlPercentageOfWinningPos.toFixed(1)}% >= ${absolutePnlPercentageThresholdForNextMoc.toFixed(1)}%). Chế độ: ${currentBotMode.toUpperCase()}`);

                if (currentBotMode === 'sideways') {
                    if (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5) { 
                        currentHourlyVol = await getHourlyVolatility(TARGET_COIN_SYMBOL); 
                        if (currentHourlyVol <= 5) { 
                            if (losingPos.closedLossAmount > 0) { 
                                addLog(`[SIDEWAYS M5 REOPEN] Lệnh thắng ${winningPos.side} tại Mốc 5. Mở lại phần đã đóng của lệnh lỗ ${losingPos.side}.`);
                                if (await addPosition(losingPos, losingPos.closedLossAmount, "sideways_moc5_reopen")) {
                                    return; 
                                }
                            } else { 
                                addLog(`[SIDEWAYS M5 CLOSE] Lệnh thắng ${winningPos.side} tại Mốc 5. Đóng 20% lệnh lỗ ${losingPos.side}.`);
                                if(await closePartialPosition(losingPos, losingPos.initialQuantity * 0.20)) winningPos.nextPartialCloseLossIndex++;
                            }
                        } else { 
                            addLog(`[SIDEWAYS -> KILL M5] Vol tăng (${currentHourlyVol.toFixed(1)}%). Chuyển sang Kill. Đóng 20% lệnh lỗ ${losingPos.side}.`);
                            currentBotMode = 'kill';
                            if(await closePartialPosition(losingPos, losingPos.initialQuantity * 0.20)) winningPos.nextPartialCloseLossIndex++;
                            
                            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                            if (currentLongPosition?.quantity > 0) await setTPAndSLForPosition(currentLongPosition, true); 
                            await sleep(300);
                            if (currentShortPosition?.quantity > 0) await setTPAndSLForPosition(currentShortPosition, true); 
                        }
                    } else { 
                        let qtyFrac = (currentMocIndexReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10; 
                        addLog(`[SIDEWAYS M${currentMocIndexReached+1} CLOSE] Lệnh thắng ${winningPos.side}. Đóng ${qtyFrac*100}% lệnh lỗ ${losingPos.side}.`);
                        if(await closePartialPosition(losingPos, qtyFrac === 1.00 ? losingPos.quantity : losingPos.initialQuantity * qtyFrac)) winningPos.nextPartialCloseLossIndex++;
                    }
                } else { 
                    currentHourlyVol = await getHourlyVolatility(TARGET_COIN_SYMBOL); 
                    if (currentHourlyVol <= 5 && currentMocIndexReached >= PARTIAL_CLOSE_INDEX_5) { 
                        addLog(`[KILL -> SIDEWAYS M${currentMocIndexReached+1}] Vol giảm (${currentHourlyVol.toFixed(1)}%). Chuyển sang Sideways. Lệnh thắng ${winningPos.side} có PNL ${actualPnlPercentageOfWinningPos.toFixed(1)}%.`);
                        currentBotMode = 'sideways';
                        
                        winningPos.pnlBaseForNextMoc = actualPnlPercentageOfWinningPos;
                        winningPos.nextPartialCloseLossIndex = 0; 
                        winningPos.hasAdjustedSLToSpecificLevel = {};
                        
                        const amountToReopenLosing = Math.max(0, losingPos.initialQuantity - losingPos.quantity);
                        if (amountToReopenLosing > 0) {
                             addLog(`Mở lại ${amountToReopenLosing.toFixed(losingPos.quantityPrecision)} cho lệnh lỗ ${losingPos.side} để về Sideways.`);
                             if (await addPosition(losingPos, amountToReopenLosing, "kill_to_sideways_reopen_losing")) {
                                 return; 
                             }
                        } else { 
                            addLog(`Lệnh lỗ ${losingPos.side} đã đủ KL. Reset TP/SL cho Sideways mode.`);
                            losingPos.pnlBaseForNextMoc = 0; 
                            losingPos.nextPartialCloseLossIndex = 0;
                            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                            if (currentLongPosition?.quantity > 0) await setTPAndSLForPosition(currentLongPosition, true);
                            await sleep(300);
                            if (currentShortPosition?.quantity > 0) await setTPAndSLForPosition(currentShortPosition, true);
                        }
                        
                    } else { 
                        let qtyFracKill = (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5) ? 0.20 : 
                                          (currentMocIndexReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10; 
                        addLog(`[KILL M${currentMocIndexReached+1} CLOSE] Lệnh thắng ${winningPos.side}. Đóng ${qtyFracKill*100}% lệnh lỗ ${losingPos.side}.`);
                        if(await closePartialPosition(losingPos, qtyFracKill === 1.00 ? losingPos.quantity : losingPos.initialQuantity * qtyFracKill)) winningPos.nextPartialCloseLossIndex++;
                        
                        if (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5 && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE]) {
                            const symbolDetailsForSL = await getSymbolDetails(losingPos.symbol);
                            if (symbolDetailsForSL) {
                                const lossPercentageForSL_Relative = PARTIAL_CLOSE_LEVEL_8_RELATIVE; 
                                const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100;
                                const targetPnlSLLosingUSD = -(losingPos.initialMargin * lossPercentageForSL_Relative / 100) + pnlBaseLosingUSD; 
                                
                                const priceChangeSLLosing = Math.abs(targetPnlSLLosingUSD) / losingPos.initialQuantity;
                                let slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeSLLosing : losingPos.entryPrice + priceChangeSLLosing).toFixed(losingPos.pricePrecision));

                                if (losingPos.side === 'LONG' && slPriceLosing >= losingPos.entryPrice) slPriceLosing = parseFloat((losingPos.entryPrice - symbolDetailsForSL.tickSize).toFixed(losingPos.pricePrecision));
                                if (losingPos.side === 'SHORT' && slPriceLosing <= losingPos.entryPrice) slPriceLosing = parseFloat((losingPos.entryPrice + symbolDetailsForSL.tickSize).toFixed(losingPos.pricePrecision));

                                if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); } catch(e){/*ignore*/} }
                                const newSLOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                                    symbol: losingPos.symbol, side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: losingPos.side, type: 'STOP_MARKET',
                                    stopPrice: slPriceLosing, quantity: losingPos.quantity, timeInForce: 'GTC', reduceOnly: 'false' 
                                });
                                if (newSLOrder.orderId) {
                                    losingPos.currentSLId = newSLOrder.orderId;
                                    winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE] = true; 
                                    addLog(`[KILL M5 SL ADJUST] SL lệnh lỗ ${losingPos.side} rời về ${slPriceLosing.toFixed(losingPos.pricePrecision)} (tương đương lệnh thắng ở Mốc 8)`);
                                } else {
                                     addLog(`[KILL M5 SL ADJUST FAIL] Lỗi đặt SL mới cho lệnh lỗ ${losingPos.side}.`);
                                }
                            }
                        }
                    }
                }
                 if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_8 && actionTakenAtMoc) ) { 
                    losingPos.hasClosedAllLossPositionAtLastLevel = true; 
                    addLog(`Lệnh lỗ ${losingPos.side} đã đóng hết hoặc lệnh thắng đã qua mốc cuối. Đánh dấu hasClosedAllLossPositionAtLastLevel.`);
                }
            }
            
            const absolutePnlThresholdForMoc8 = (winningPos.pnlBaseForNextMoc || 0) + PARTIAL_CLOSE_LEVEL_8_RELATIVE;
            if (PARTIAL_CLOSE_LEVEL_8_RELATIVE !== undefined && 
                actualPnlPercentageOfWinningPos >= absolutePnlThresholdForMoc8 && 
                !losingPos.hasClosedAllLossPositionAtLastLevel && losingPos.quantity > 0 && 
                !actionTakenAtMoc) { 
                 addLog(`[POST MOC8 CLEANUP] Lệnh thắng ${winningPos.side} ở PNL >= Mốc 8. Đóng nốt lệnh lỗ ${losingPos.side}.`);
                 if (await closePosition(losingPos.symbol, `Đóng nốt ở Mốc 8 lãi lệnh thắng`, losingPos.side)){
                    if (losingPos) { losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; }
                 }
             }
        }
    } catch (error) { if(error instanceof CriticalApiError) stopBotLogicInternal(); }
};

async function scheduleNextMainCycle() { if (!botRunning || currentLongPosition || currentShortPosition) return; clearTimeout(nextScheduledCycleTimeout); nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000); }
async function getListenKey() { if (!API_KEY || !SECRET_KEY) return null; try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); return data.listenKey; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }
async function keepAliveListenKey() { if (listenKey) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 1000); } } } }
function setupMarketDataStream(symbol) { if (marketWs) marketWs.close(); const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${symbol.toLowerCase()}@markPrice@1s`; marketWs = new WebSocket(streamUrl); marketWs.onopen = () => {}; marketWs.onmessage = (event) => { try { const data = JSON.parse(event.data); if (data.e === 'markPriceUpdate' && data.s === symbol) currentMarketPrice = parseFloat(data.p); } catch (e) {} }; marketWs.onclose = (event) => { marketWs = null; if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); }; marketWs.onerror = (error) => { marketWs = null; if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); }; }
function setupUserDataStream(key) { if (userDataWs) userDataWs.close(); const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`; userDataWs = new WebSocket(streamUrl); userDataWs.onopen = () => { if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); }; userDataWs.onmessage = async (event) => { try { const data = JSON.parse(event.data); if (data.e === 'ORDER_TRADE_UPDATE') await processTradeResult(data.o); } catch (e) {} }; userDataWs.onclose = async (event) => { userDataWs = null; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); } }; userDataWs.onerror = (error) => { userDataWs = null; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); } }; }

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.';
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        const initialVolatility = await getHourlyVolatility(TARGET_COIN_SYMBOL);
        currentBotMode = (initialVolatility <= 5) ? 'sideways' : 'kill';
        addLog(`Chế độ ${currentBotMode.toUpperCase()} khi khởi động (Vol 1h: ${initialVolatility.toFixed(2)}%)`);
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey); else addLog("Không lấy được listenKey.");
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT | Chế độ: ${currentBotMode.toUpperCase()} ---`);
        scheduleNextMainCycle(); return 'Bot khởi động thành công.';
    } catch (error) {
        stopBotLogicInternal();
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            retryBotTimeout = setTimeout(async () => { retryBotTimeout = null; await startBotLogicInternal(); }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${error.msg || error.message}`;
    }
}
function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    addLog('--- Dừng Bot ---');
    botRunning = false; clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) clearInterval(positionCheckInterval); positionCheckInterval = null;
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
    if (marketWs) marketWs.close(); marketWs = null;
    if (userDataWs) userDataWs.close(); userDataWs = null;
    listenKey = null; currentLongPosition = null; currentShortPosition = null;
    isProcessingTrade = false; consecutiveApiErrors = 0;
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Bot đã dừng ---'); return 'Bot đã dừng.';
}
async function checkAndHandleRemainingPosition(symbol) {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remaining = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remaining.length > 0) {
            addLog(`Tìm thấy ${remaining.length} vị thế sót. Đang đóng...`);
            await cancelAllOpenOrdersForSymbol(symbol); await sleep(500);
            for (const pos of remaining) {
                await closePosition(pos.symbol, `Vị thế sót`, parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT');
                await sleep(1000);
            }
        }
    } catch (error) { if (error instanceof CriticalApiError) stopBotLogicInternal(); }
}

const app = express(); app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) return res.status(500).send('Lỗi đọc log'); const clean = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(clean.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => exec('pm2 jlist', (e, stdout, stderr) => e ? reject(stderr || e.message) : resolve(stdout)));
        const processes = JSON.parse(pm2List);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME);
        let statusMsg = `Bot PM2 '${THIS_BOT_PM2_NAME}' không tìm thấy.`;
        if (botProcess) {
            statusMsg = `MÁY CHỦ: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMsg += ` | BOT: ${botRunning ? 'CHẠY' : 'DỪNG'}`;
                if (botStartTime && botRunning) statusMsg += ` | Uptime: ${Math.floor((Date.now() - botStartTime.getTime()) / 60000)}p`;
                statusMsg += ` | ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | Mode: ${currentBotMode.toUpperCase()} (Vol:${lastHourVolatility.toFixed(1)}%)`;
                let posText = " | Vị thế: --";
                if(currentLongPosition || currentShortPosition) {
                    posText = " | Vị thế: ";
                    if(currentLongPosition) posText += `L(${(currentLongPosition.unrealizedPnl || 0).toFixed(1)} PNLb:${(currentLongPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${(currentLongPosition.nextPartialCloseLossIndex || 0) +1}) `;
                    if(currentShortPosition) posText += `S(${(currentShortPosition.unrealizedPnl || 0).toFixed(1)} PNLb:${(currentShortPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${(currentShortPosition.nextPartialCloseLossIndex || 0) +1})`;
                }
                statusMsg += posText;
            }
        }
        res.send(statusMsg);
    } catch (error) { res.status(500).send(`Lỗi lấy trạng thái PM2: ${error.message}`); }
});
app.get('/api/bot_stats', (req, res) => {
    let openPosData = [];
    [currentLongPosition, currentShortPosition].forEach(pos => {
        if (pos) openPosData.push({
            side: pos.side, entry: pos.entryPrice?.toFixed(pos.pricePrecision || 2), qty: pos.quantity?.toFixed(pos.quantityPrecision || 3),
            pnl: (pos.unrealizedPnl || 0).toFixed(2), curPrice: pos.currentPrice?.toFixed(pos.pricePrecision || 2),
            initQty: pos.initialQuantity?.toFixed(pos.quantityPrecision || 3), closedLoss: pos.closedLossAmount?.toFixed(pos.quantityPrecision || 3),
            pairEntry: pos.pairEntryPrice?.toFixed(pos.pricePrecision || 2), mocIdx: pos.nextPartialCloseLossIndex, pnlBase: (pos.pnlBaseForNextMoc || 0).toFixed(2)
        });
    });
    res.json({ success: true, data: { status: botRunning ? 'CHẠY' : 'DỪNG', mode: currentBotMode.toUpperCase(), vol: lastHourVolatility.toFixed(2), profit: totalProfit.toFixed(2), loss: totalLoss.toFixed(2), net: netPNL.toFixed(2), positions: openPosData, invest: INITIAL_INVESTMENT_AMOUNT, coin: TARGET_COIN_SYMBOL } });
});
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body; let changed = false;
    
    if (coinConfigs && coinConfigs.length > 0) {
        const cfg = coinConfigs[0]; 
        let coinConfigChanged = false;
        if (cfg.symbol && cfg.symbol.trim().toUpperCase() !== TARGET_COIN_SYMBOL) { 
            TARGET_COIN_SYMBOL = cfg.symbol.trim().toUpperCase(); 
            coinConfigChanged = true; 
        }
        if (cfg.initialAmount && parseFloat(cfg.initialAmount) !== INITIAL_INVESTMENT_AMOUNT && parseFloat(cfg.initialAmount) > 0) { 
            INITIAL_INVESTMENT_AMOUNT = parseFloat(cfg.initialAmount); 
            coinConfigChanged = true; 
        }
        if (coinConfigChanged) { 
            changed = true; 
            totalProfit=0; totalLoss=0; netPNL=0; 
            if (botRunning) { 
                stopBotLogicInternal(); 
                addLog("Cấu hình coin thay đổi, bot dừng. Khởi động lại để áp dụng."); 
            }
        }
    }
    res.json({ success: changed, message: changed ? 'Cấu hình cập nhật. Khởi động lại bot nếu cần.' : 'Không có thay đổi.' });
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT, () => addLog(`Web server: http://localhost:${WEB_SERVER_PORT}`));
