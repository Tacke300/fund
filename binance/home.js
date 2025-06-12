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

// Cấu trúc vị thế được cập nhật: Bỏ các trường liên quan đến đóng lãi từng phần, giữ lại các trường cho đóng lỗ
let currentLongPosition = null; // { symbol, quantity, initialQuantity, entryPrice, initialTPPrice, initialSLPrice, ..., closedLossAmount, partialCloseLossLevels, nextPartialCloseLossIndex, ... }
let currentShortPosition = null; // Tương tự

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

let INITIAL_INVESTMENT_AMOUNT = 1;
let TARGET_COIN_SYMBOL = 'ETHUSDT';

let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;

const WEB_SERVER_PORT = 1111;
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;

// --- CÁC HÀM TIỆN ÍCH CƠ BẢN (Không thay đổi nhiều) ---

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
                const repeatedMessage = `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`;
                console.log(repeatedMessage);
                 if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, repeatedMessage + '\n', () => {});
            } else {
                console.log(logEntry);
                if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', () => {});
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', () => {});
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
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
                    let errorDetails = { code: res.statusCode, msg: `HTTP Error: ${res.statusCode}` };
                    try { errorDetails = { ...errorDetails, ...JSON.parse(data) }; } catch (e) {}
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
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("API Key/Secret chưa được cấu hình.");
    
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
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
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params).map(key => `${key}=${params[key]}`).join('&');
    const fullPathWithQuery = `${fullEndpointPath}?${queryString}`;
    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, {});
        return JSON.parse(rawData);
    } catch (error) {
        addLog(`Lỗi API công khai: ${error.msg || error.message}`);
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- CÁC HÀM API WRAPPER (GET INFO, SET LEVERAGE, ...) ---
async function syncServerTime() { try { const data = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = data.serverTime - Date.now(); addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`); } catch (error) { throw error; } }
async function getLeverageBracketForSymbol(symbol) { try { const res = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); return parseInt(res.find(i => i.symbol === symbol)?.brackets[0]?.initialLeverage); } catch (e) { addLog(`Lỗi lấy đòn bẩy: ${e.msg}`); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy: ${e.msg}`); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const data = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; data.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p.tickSize), stepSize: parseFloat(l.stepSize), minNotional: parseFloat(m.notional) }; }); addLog('Đã tải thông tin sàn.'); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const filters = await getExchangeInfo(); if (!filters?.[symbol]) { addLog(`Không tìm thấy filters cho ${symbol}.`); return null; } return filters[symbol]; }
async function getCurrentPrice(symbol) { try { const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(data.price); } catch (e) { return null; } }
async function cancelOpenOrdersForSymbol(symbol) { try { addLog(`Đang hủy tất cả lệnh chờ cho ${symbol}.`); await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol }); } catch (error) { if (error.code !== -2011) addLog(`Lỗi hủy lệnh chờ: ${error.msg || error.message}`); } }


// --- CÁC HÀM KHÔI PHỤC TỪ BẢN GỐC (Đóng từng phần, Mở thêm) ---

/**
 * Hàm đóng từng phần vị thế LỖ.
 */
async function closePartialPosition(position, percentageOfInitialQuantity) {
    if (position.initialQuantity <= 0) return;
    
    addLog(`Đang đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh LỖ ${position.side} ${position.symbol}.`);
    try {
        const symbolInfo = await getSymbolDetails(position.symbol);
        let quantityToClose = position.initialQuantity * (percentageOfInitialQuantity / 100);

        const roundToStepSize = (qty, step) => Math.floor(qty / step) * step;
        quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
        quantityToClose = parseFloat(quantityToClose.toFixed(symbolInfo.quantityPrecision));

        const currentPrice = await getCurrentPrice(position.symbol);
        if (quantityToClose <= 0 || (quantityToClose * currentPrice) < symbolInfo.minNotional) {
            addLog(`Số lượng đóng từng phần quá nhỏ. Bỏ qua.`);
            return;
        }

        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol, side: closeSide, positionSide: position.side,
            type: 'MARKET', quantity: quantityToClose,
        });

        const usdtAmountClosed = quantityToClose * currentPrice;
        position.closedLossAmount += usdtAmountClosed;
        addLog(`Đã gửi lệnh đóng từng phần cho lệnh lỗ. Tổng vốn đã cắt từ lệnh lỗ: ${position.closedLossAmount.toFixed(2)} USDT.`);
    } catch (error) {
        addLog(`Lỗi khi đóng từng phần lệnh lỗ ${position.side}: ${error.msg || error.message}`);
    }
}

/**
 * Hàm mở thêm vị thế LỖ đã bị cắt trước đó.
 */
async function addPosition(position, amountToReopen) {
    if (amountToReopen <= 0) return;
    addLog(`Đang mở thêm ${amountToReopen.toFixed(2)} USDT cho lệnh ${position.side} ${position.symbol} để bù lỗ đã cắt.`);
    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        const currentPrice = await getCurrentPrice(position.symbol);
        const maxLeverage = position.maxLeverageUsed;

        let quantityToAdd = (amountToReopen * maxLeverage) / currentPrice;
        quantityToAdd = Math.floor(quantityToAdd / symbolDetails.stepSize) * symbolDetails.stepSize;
        quantityToAdd = parseFloat(quantityToAdd.toFixed(symbolDetails.quantityPrecision));

        if (quantityToAdd <= 0 || (quantityToAdd * currentPrice) < symbolDetails.minNotional) {
            addLog(`Số lượng mở thêm quá nhỏ. Bỏ qua.`);
            return;
        }

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol, side: orderSide, positionSide: position.side,
            type: 'MARKET', quantity: quantityToAdd
        });

        // Reset trạng thái và cập nhật lại SL cho vị thế tổng
        position.closedLossAmount = 0;
        position.nextPartialCloseLossIndex = 0;
        await updateStopLossForTotalPosition(position, maxLeverage);
    } catch (error) {
        addLog(`Lỗi khi mở thêm lệnh cho ${position.side}: ${error.msg || error.message}`);
    }
}

/**
 * Cập nhật lại lệnh SL cho tổng vị thế sau khi mở thêm.
 */
async function updateStopLossForTotalPosition(position, maxLeverage) {
    addLog(`Đang cập nhật SL cho tổng vị thế ${position.side} ${position.symbol}.`);
    try {
        // Lấy lại quantity mới nhất từ sàn
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: position.symbol });
        const posOnBinance = positions.find(p => p.positionSide === position.side);
        if (!posOnBinance) return;
        
        position.quantity = Math.abs(parseFloat(posOnBinance.positionAmt));
        position.entryPrice = parseFloat(posOnBinance.entryPrice); // Cập nhật giá vào lệnh trung bình mới
        
        await cancelOpenOrdersForSymbol(position.symbol); // Hủy cả TP/SL cũ để đặt lại

        // Đặt lại SL
        const { pricePrecision, tickSize } = await getSymbolDetails(position.symbol);
        let STOP_LOSS_MULTIPLIER;
        if (maxLeverage >= 75) STOP_LOSS_MULTIPLIER = 6.66;
        else if (maxLeverage >= 50) STOP_LOSS_MULTIPLIER = 3.33;
        else STOP_LOSS_MULTIPLIER = 2.22;

        const lossLimitUSDT = position.initialMargin * STOP_LOSS_MULTIPLIER;
        const priceChangeForSL = lossLimitUSDT / position.quantity;
        const slPrice = position.side === 'LONG' ? (position.entryPrice - priceChangeForSL) : (position.entryPrice + priceChangeForSL);
        const formattedSL = parseFloat(slPrice.toFixed(pricePrecision));

        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol, side: position.side === 'LONG' ? 'SELL' : 'BUY',
            positionSide: position.side, type: 'STOP_MARKET',
            stopPrice: formattedSL, quantity: position.quantity, reduceOnly: 'true'
        });
        position.currentSLId = slOrder.orderId;
        position.initialSLPrice = formattedSL;
        addLog(`Đã đặt lại SL mới cho ${position.side} @ ${formattedSL}.`);
        
        // Đặt lại TP
        // (Logic này có thể được thêm vào nếu muốn TP cũng được điều chỉnh theo giá vào lệnh trung bình mới)

    } catch (error) {
        addLog(`Lỗi cập nhật SL sau khi mở thêm: ${error.msg || error.message}`);
    }
}


// --- LOGIC GIAO DỊCH CHÍNH ---

async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ giao dịch cho ${symbol} đã kết thúc. Dọn dẹp sau 3 giây...`);
    await sleep(3000);

    currentLongPosition = null;
    currentShortPosition = null;
    if (positionCheckInterval) clearInterval(positionCheckInterval);
    positionCheckInterval = null;

    await cancelOpenOrdersForSymbol(symbol);
    await checkAndHandleRemainingPosition(symbol);

    if (botRunning) scheduleNextMainCycle();
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;
    const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED' || realizedPnl === 0) return;

    addLog(`[Trade Result] Lệnh ${orderId} (${positionSide}) khớp. PNL: ${realizedPnl.toFixed(4)} USDT.`);

    if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
    netPNL = totalProfit - totalLoss;
    addLog(`PNL Ròng: ${netPNL.toFixed(2)} USDT (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`);
    
    const isLongClosure = currentLongPosition && (orderId == currentLongPosition.currentTPId || orderId == currentLongPosition.currentSLId);
    const isShortClosure = currentShortPosition && (orderId == currentShortPosition.currentTPId || orderId == currentShortPosition.currentSLId);

    if (!isLongClosure && !isShortClosure) return;

    if (realizedPnl >= 0) { // Lệnh LÃI đã đóng
        addLog(`Vị thế LÃI (${positionSide}) đã đóng. Đóng nốt vị thế LỖ còn lại.`);
        const remainingPosition = (positionSide === 'LONG') ? currentShortPosition : currentLongPosition;
        if (remainingPosition) {
            await closePosition(remainingPosition.symbol, `Đóng do lệnh LÃI đối ứng đã chốt`, remainingPosition.side);
        }
        cleanupAndResetCycle(symbol);
    } else { // Lệnh LỖ đã đóng
        addLog(`Vị thế LỖ (${positionSide}) đã đóng. Để vị thế LÃI tiếp tục chạy.`);
        if (positionSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;
    }
}

async function closePosition(symbol, reason, positionSide) {
    if (!positionSide) return;
    if (isClosingPosition) return;
    isClosingPosition = true;

    addLog(`Đang chuẩn bị đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason}).`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnBinance = positions.find(p => p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);
        if (posOnBinance) {
            const qtyToClose = Math.abs(parseFloat(posOnBinance.positionAmt));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide, type: 'MARKET', quantity: qtyToClose });
            addLog(`Đã gửi lệnh đóng ${positionSide}.`);
        } else {
            addLog(`Vị thế ${positionSide} đã được đóng.`);
        }
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${positionSide}: ${error.msg || error.message}`);
    } finally {
        isClosingPosition = false;
    }
}

async function openPosition(symbol, tradeDirection, maxLeverage) {
    addLog(`Đang chuẩn bị mở ${tradeDirection} ${symbol} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!await setLeverage(symbol, maxLeverage)) throw new Error(`Lỗi đặt đòn bẩy.`);
        
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) throw new Error(`Lỗi lấy giá.`);

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / currentPrice;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));
        if (quantity * currentPrice < symbolDetails.minNotional) throw new Error("Giá trị lệnh quá nhỏ.");
        
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity });
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const openPos = positions.find(p => p.positionSide === tradeDirection && parseFloat(p.positionAmt) !== 0);
        if (!openPos) throw new Error("Không tìm thấy vị thế sau khi mở.");
        
        const entryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`Đã mở ${tradeDirection} | Qty: ${actualQuantity} | Giá vào: ${entryPrice.toFixed(symbolDetails.pricePrecision)}`);

        await cancelOpenOrdersForSymbol(symbol);

        // --- Cấu hình TP/SL và các mốc ---
        let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER;
        let partialCloseLossSteps = [];
        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = 6.66;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100);
        } else if (maxLeverage >= 50) {
            TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = 3.33;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50);
        } else {
            TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 2.22;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35);
        }
        
        const priceChangeForTP = (INITIAL_INVESTMENT_AMOUNT * TAKE_PROFIT_MULTIPLIER) / actualQuantity;
        const priceChangeForSL = (INITIAL_INVESTMENT_AMOUNT * STOP_LOSS_MULTIPLIER) / actualQuantity;
        
        const slPrice = parseFloat((tradeDirection === 'LONG' ? entryPrice - priceChangeForSL : entryPrice + priceChangeForSL).toFixed(symbolDetails.pricePrecision));
        const tpPrice = parseFloat((tradeDirection === 'LONG' ? entryPrice + priceChangeForTP : entryPrice - priceChangeForTP).toFixed(symbolDetails.pricePrecision));

        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide === 'BUY' ? 'SELL' : 'BUY', positionSide: tradeDirection, type: 'STOP_MARKET', stopPrice: slPrice, quantity: actualQuantity, reduceOnly: 'true' });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide === 'BUY' ? 'SELL' : 'BUY', positionSide: tradeDirection, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity: actualQuantity, reduceOnly: 'true' });
        addLog(`TP: ${tpPrice} (ID: ${tpOrder.orderId}) | SL: ${slPrice} (ID: ${slOrder.orderId})`);
        
        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, entryPrice,
            initialTPPrice: tpPrice, initialSLPrice: slPrice, initialMargin: INITIAL_INVESTMENT_AMOUNT,
            side: tradeDirection, currentTPId: tpOrder.orderId, currentSLId: slOrder.orderId,
            maxLeverageUsed: maxLeverage, closedLossAmount: 0,
            partialCloseLossLevels: partialCloseLossSteps, nextPartialCloseLossIndex: 0,
            hasAdjustedSLTo200PercentProfit: false, hasAdjustedSLTo500PercentProfit: false,
        };
    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection}: ${error.msg || error.message}`);
        return null;
    }
}

async function manageOpenPosition() {
    if (!currentLongPosition && !currentShortPosition) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        return;
    }
    if (isClosingPosition) return;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        let longPos = positions.find(p => p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
        let shortPos = positions.find(p => p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);

        if (currentLongPosition && !longPos) { addLog(`Vị thế LONG đã đóng trên sàn.`); currentLongPosition = null; }
        if (currentShortPosition && !shortPos) { addLog(`Vị thế SHORT đã đóng trên sàn.`); currentShortPosition = null; }

        if (longPos && currentLongPosition) currentLongPosition.unrealizedPnl = parseFloat(longPos.unRealizedProfit);
        if (shortPos && currentShortPosition) currentShortPosition.unrealizedPnl = parseFloat(shortPos.unRealizedProfit);

        if (!longPos && !shortPos && botRunning) {
            cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

        // Xác định lệnh lãi và lỗ
        let winningPos = null, losingPos = null;
        if (currentLongPosition && currentLongPosition.unrealizedPnl > 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
        else if (currentShortPosition && currentShortPosition.unrealizedPnl > 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }

        if (winningPos && losingPos) {
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

            // Logic đóng từng phần LỆNH LỖ
            const nextLossCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel) {
                await closePartialPosition(losingPos, 10);
                winningPos.nextPartialCloseLossIndex++;
            }
            
            // Logic mở lại LỆNH LỖ đã cắt khi LỆNH LÃI về 0
            if (losingPos.closedLossAmount > 0 && currentProfitPercentage <= 0.1) {
                await addPosition(losingPos, losingPos.closedLossAmount);
            }
        }

    } catch (error) {
        addLog(`Lỗi quản lý vị thế: ${error.msg || error.message}`);
    }
}


async function runTradingLogic() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;

    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) { if(botRunning) scheduleNextMainCycle(); return; }

        currentLongPosition = await openPosition(TARGET_COIN_SYMBOL, 'LONG', maxLeverage);
        if (!currentLongPosition) { if(botRunning) scheduleNextMainCycle(); return; }
        
        await sleep(1000);

        currentShortPosition = await openPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLeverage);
        if (!currentShortPosition) {
            addLog('Lỗi mở lệnh SHORT. Đóng lệnh LONG đã mở.');
            await closePosition(currentLongPosition.symbol, 'Lỗi mở lệnh SHORT', 'LONG');
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(manageOpenPosition, 5000);
        }
    } catch (error) {
        addLog(`Lỗi trong chu kỳ chính: ${error.msg || error.message}`);
        if(botRunning) scheduleNextMainCycle();
    }
}

async function scheduleNextMainCycle() {
    if (!botRunning || currentLongPosition || currentShortPosition) return;
    clearTimeout(nextScheduledCycleTimeout);
    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

// --- WEBSOCKET VÀ CÁC HÀM KHỞI ĐỘNG/DỪNG (KHÔNG THAY ĐỔI) ---

async function getListenKey() { try { const data = await callSignedAPI('/fapi/v1/listenKey', 'POST'); return data.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.msg}`); return null; } }
async function keepAliveListenKey() { if (listenKey) try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) { addLog(`Lỗi làm mới listenKey: ${e.msg}`); } }

function setupMarketDataStream(symbol) {
    if (marketWs) marketWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice@1s`;
    marketWs = new WebSocket(streamUrl);
    marketWs.onopen = () => addLog(`Market WebSocket cho ${symbol} đã kết nối.`);
    marketWs.onclose = () => { if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); };
}

function setupUserDataStream(key) {
    if (userDataWs) userDataWs.close();
    const streamUrl = `${WS_BASE_URL}/ws/${key}`;
    userDataWs = new WebSocket(streamUrl);
    userDataWs.onopen = () => { addLog('User Data WebSocket đã kết nối.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); };
    userDataWs.onmessage = async (event) => { try { const data = JSON.parse(event.data); if (data.e === 'ORDER_TRADE_UPDATE') await processTradeResult(data.o); } catch (e) { } };
    userDataWs.onclose = async () => { if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); } };
}

async function checkAndHandleRemainingPosition(symbol) {
    // Hàm này giờ chỉ dùng để đóng lệnh sót lại, không khôi phục trạng thái nữa
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', {symbol});
        const remaining = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remaining.length > 0) {
            addLog(`Tìm thấy ${remaining.length} vị thế sót. Đang đóng...`);
            for (const pos of remaining) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                await closePosition(pos.symbol, `Vị thế sót`, sideToClose);
            }
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót: ${error.msg || error.message}`);
    }
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đang chạy.';
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
        addLog(`--- Bot đã chạy | Coin: ${TARGET_COIN_SYMBOL} | Vốn/lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        
        scheduleNextMainCycle();
        return 'Bot khởi động thành công.';
    } catch (error) {
        addLog(`[Lỗi khởi động bot] ${error.msg || error.message}`);
        stopBotLogicInternal();
        return `Lỗi khởi động bot: ${error.msg || error.message}`;
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

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) return res.status(500).send('Lỗi đọc log file'); const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(cleanData.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', (req, res) => { let statusMessage = `TRANG THAI: ${botRunning ? 'DANG CHAY' : 'DA DUNG'} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`; res.send(statusMessage); });
app.get('/api/bot_stats', (req, res) => { res.json({ success: true, data: { totalProfit, totalLoss, netPNL, currentOpenPositions: [currentLongPosition, currentShortPosition].filter(p => p), currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT, } }); });
app.post('/api/configure', (req, res) => { const config = req.body.coinConfigs?.[0]; if (config) { TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase(); INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount); if (botRunning) setupMarketDataStream(TARGET_COIN_SYMBOL); res.json({ success: true, message: 'Cấu hình đã cập nhật.' }); } else { res.status(400).send('Dữ liệu không hợp lệ.'); } });
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT, () => addLog(`Web server trên cổng ${WEB_SERVER_PORT}`));
