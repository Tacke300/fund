import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws'; // Vẫn cần 'ws' cho WebSocket client
import { URL } from 'url'; // Để parse URL

import { API_KEY, SECRET_KEY } from './config.js'; // Đảm bảo file config.js tồn tại

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Cấu hình quan trọng ---
const VPS1_DATA_URL = 'http://<IP_CUA_VPS1>:9000/api/top-coins'; // !!! THAY <IP_CUA_VPS1> BẰNG IP THẬT CỦA VPS1 !!!
const VPS_SPECIFIC_DELAY_MS = parseInt(process.env.VPS_DELAY) || Math.floor(Math.random() * 8000) + 2000;
const MIN_CANDLES_FOR_SELECTION = 55;
const VOLATILITY_SWITCH_THRESHOLD_PERCENT = 5.0;
const COIN_SWITCH_CHECK_INTERVAL_MS = 30 * 1000;
// --- Kết thúc cấu hình quan trọng ---

const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

const WEB_SERVER_PORT = parseInt(process.env.WEB_PORT) || 1277;
const THIS_BOT_PM2_NAME = process.env.PM2_APP_NAME || 'goat_client_bot';
const CUSTOM_LOG_FILE = path.join(__dirname, `pm2_client_${WEB_SERVER_PORT}.log`);
const LOG_TO_CUSTOM_FILE = true;

const MAX_CONSECUTIVE_API_ERRORS = 5;
const ERROR_RETRY_DELAY_MS = 15000;
const LOG_COOLDOWN_MS = 2000;

const SIDEWAYS_INITIAL_TRIGGER_PERCENT = 0.005;
const SIDEWAYS_ORDER_SIZE_RATIO = 0.10;
const SIDEWAYS_GRID_RANGE_PERCENT = 0.05;
const SIDEWAYS_GRID_STEP_PERCENT = 0.005;
const SIDEWAYS_TP_PERCENT_FROM_ENTRY = 0.01;
const SIDEWAYS_SL_PERCENT_FROM_ENTRY = 0.05;

const OVERALL_VOLATILITY_THRESHOLD = 5;
const VOLATILITY_CHECK_INTERVAL_MS = 1 * 60 * 1000;
const KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS = 70 * 1000;

let serverTimeOffset = 0;
let exchangeInfoCache = null;
let isProcessingTrade = false;
let botRunning = false;
let botStartTime = null;

let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;
let retryBotTimeout = null;
const logCounts = {};

let currentBotMode = 'kill';
let lastCalculatedVolatility = 0;

let INITIAL_INVESTMENT_AMOUNT = 0.12;
let TARGET_COIN_SYMBOL = null;
let targetOverallTakeProfit = 0;
let targetOverallStopLoss = 0;

let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null;
let consecutiveApiErrors = 0;

let sidewaysGrid = {
    isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null,
    lastGridMoveTime: null, activeGridPositions: [],
    sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 },
    lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null
};
let lastCoinSwitchCheckTime = 0;

class CriticalApiError extends Error {
    constructor(message) { super(message); this.name = 'CriticalApiError'; }
}

function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;
    const messageHash = crypto.createHash('md5').update(message).digest('hex');
    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) { return; }
        else {
            if (logCounts[messageHash].count > 1) {
                const logText = `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`;
                console.log(logText);
                if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logText + '\n', (err) => { if (err) console.error("Lỗi ghi log:", err);});
            } else {
                console.log(logEntry);
                if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {if (err) console.error("Lỗi ghi log:", err);});
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {if (err) console.error("Lỗi ghi log:", err);});
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
}

function formatTimeUTC7(dateObject) { const formatter = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }); return formatter.format(dateObject); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers, timeout: 10000 };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; }
                    catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; }
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: e.message }));
        req.on('timeout', () => { req.destroy(); reject({ code: 'TIMEOUT_ERROR', msg: 'Request timed out' }); });
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
    let requestPath; let requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };
    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    } else if (method === 'POST' || method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else { throw new Error(`Phương thức không hỗ trợ: ${method}`); }
    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); }
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
        addLog(`Lỗi API công khai (${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function fetchTopCoinsFromVPS1() {
    addLog(`Đang lấy dữ liệu top coin từ VPS1: ${VPS1_DATA_URL}`);
    try {
        const parsedVps1Url = new URL(VPS1_DATA_URL);
        const rawData = await makeHttpRequest('GET', parsedVps1Url.hostname, parsedVps1Url.pathname + parsedVps1Url.search, {});
        const coins = JSON.parse(rawData);
        if (Array.isArray(coins)) {
            return coins.filter(c => c.symbol && typeof c.changePercent === 'number' && c.candles >= MIN_CANDLES_FOR_SELECTION);
        }
        addLog("Lỗi: Dữ liệu từ VPS1 không phải là một mảng hoặc rỗng.");
        return [];
    } catch (error) {
        addLog(`Lỗi khi lấy dữ liệu từ VPS1: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        return [];
    }
}

async function checkExistingPosition(symbol) {
    if (!symbol) return false;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const existing = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        return !!existing;
    } catch (error) {
        if (error.code && error.code === -4003 && error.msg && error.msg.toLowerCase().includes("invalid symbol")) {
             return false;
        }
        addLog(`Lỗi khi kiểm tra vị thế cho ${symbol}: ${error.msg || error.message}. Coi như có vị thế để an toàn.`);
        return true;
    }
}

async function selectTargetCoin(isInitialSelection = false) {
    addLog("Đang chọn coin mục tiêu...");
    const topCoins = await fetchTopCoinsFromVPS1();
    if (topCoins.length === 0) {
        addLog("Không có coin nào từ VPS1 hoặc có lỗi. Không thể chọn coin.");
        return null;
    }

    addLog(`Đã nhận ${topCoins.length} coin tiềm năng từ VPS1. Bắt đầu kiểm tra vị thế...`);
    for (let i = 0; i < topCoins.length; i++) {
        const coin = topCoins[i];
        addLog(`Kiểm tra coin #${i + 1}: ${coin.symbol} (${coin.changePercent}%)`);
        const hasPosition = await checkExistingPosition(coin.symbol);
        await sleep(300);
        if (!hasPosition) {
            addLog(`Đã chọn ${coin.symbol} (${coin.changePercent}%) làm coin mục tiêu. Chưa có vị thế.`);
            return coin.symbol;
        } else {
            addLog(`Đã có vị thế cho ${coin.symbol}. Bỏ qua.`);
        }
    }
    if (isInitialSelection) {
      addLog("Tất cả các coin trong top từ VPS1 đều đã có vị thế. Không thể chọn coin MỚI BAN ĐẦU.");
    } else {
      addLog("Tất cả các coin trong top từ VPS1 đều đã có vị thế. Không thể chọn coin MỚI để chuyển.");
    }
    return null;
}

async function calculateVolatilityLastHour(symbol) {
    if(!symbol) return lastCalculatedVolatility;
    try {
        const klines = await callPublicAPI('/fapi/v1/klines', { symbol: symbol, interval: '1m', limit: 60 });
        if (klines && klines.length === 60) {
            let minLow = parseFloat(klines[0][3]); let maxHigh = parseFloat(klines[0][2]);
            for (let i = 1; i < klines.length; i++) {
                const low = parseFloat(klines[i][3]); const high = parseFloat(klines[i][2]);
                if (low < minLow) minLow = low; if (high > maxHigh) maxHigh = high;
            }
            if (minLow > 0) {
                const volatility = ((maxHigh - minLow) / minLow) * 100;
                lastCalculatedVolatility = volatility; return volatility;
            }
        }
        return lastCalculatedVolatility;
    } catch (e) {
        addLog(`Lỗi tính biến động 1 giờ qua cho ${symbol}: ${e.message}`);
        if (e instanceof CriticalApiError) throw e; return lastCalculatedVolatility;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); } catch (e) { if (e instanceof CriticalApiError) await stopBotLogicInternal(); throw e; } }
async function getLeverageBracketForSymbol(symbol) { if(!symbol) return null; try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const b = r.find(i => i.symbol === symbol)?.brackets[0]; return b ? parseInt(b.initialLeverage) : null; } catch (e) { if (e instanceof CriticalApiError) await stopBotLogicInternal(); return null; } }
async function setLeverage(symbol, leverage) { if(!symbol) return false; try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { if (e instanceof CriticalApiError) await stopBotLogicInternal(); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const pF = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const lF = s.filters.find(f => f.filterType === 'LOT_SIZE'); const mF = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(pF?.tickSize || 0.001), stepSize: parseFloat(lF?.stepSize || 0.001), minNotional: parseFloat(mF?.notional || 0) }; }); return exchangeInfoCache; } catch (e) { if (e instanceof CriticalApiError) await stopBotLogicInternal(); throw e; } }
async function getSymbolDetails(symbol) { if(!symbol) return null; const info = await getExchangeInfo(); return info?.[symbol] || null; }
async function getCurrentPrice(symbol) { if(!symbol) return null; try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { if (e instanceof CriticalApiError) await stopBotLogicInternal(); return null; } }

async function cancelAllOpenOrdersForSymbol(symbol) {
    if (!symbol) return;
    addLog(`Hủy TẤT CẢ lệnh chờ cho ${symbol}...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) { return; }
        for (const order of openOrders) {
            try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId }); await sleep(50); }
            catch (innerErr) { if (innerErr.code !== -2011) addLog(`Lỗi hủy lệnh ${order.orderId}: ${innerErr.msg}`); if (innerErr instanceof CriticalApiError) await stopBotLogicInternal(); }
        }
    } catch (error) { if (error.code !== -2011) addLog(`Lỗi lấy lệnh chờ hủy cho ${symbol}: ${error.msg}`); if (error instanceof CriticalApiError) await stopBotLogicInternal(); }
}

async function closePosition(symbol, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;
    isProcessingTrade = true; addLog(`Đóng lệnh KILL ${positionSide} ${symbol} (Lý do: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);
        if (posOnEx) {
            const qty = Math.abs(parseFloat(posOnEx.positionAmt)); if (qty === 0) { isProcessingTrade = false; return false; }
            const side = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side, positionSide, type: 'MARKET', quantity: qty });
            if (positionSide === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
            else if (positionSide === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;
            isProcessingTrade = false; return true;
        } else { isProcessingTrade = false; return false; }
    } catch (err) { addLog(`Lỗi đóng vị thế KILL ${positionSide} cho ${symbol}: ${err.msg}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError) && !(err && err.code && err.code <0 && err.code !== -2011) ) isProcessingTrade = false; }
}

async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    if(!symbol) return null;
    addLog(`[KILL] Mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol cho ${symbol}.`);
        if (!await setLeverage(symbol, maxLeverage)) throw new Error(`Lỗi đặt đòn bẩy cho ${symbol}.`); await sleep(200);
        const priceCalc = entryPriceOverride || await getCurrentPrice(symbol); if (!priceCalc) throw new Error(`Lỗi lấy giá cho ${symbol}.`);
        let qty = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceCalc;
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qty * priceCalc < details.minNotional) throw new Error(`Giá trị lệnh quá nhỏ cho ${symbol}.`);
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const orderRes = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
        const actualEntry = parseFloat(orderRes.avgPrice); const actualQty = parseFloat(orderRes.executedQty);
        if (actualQty === 0) throw new Error(`Lệnh MARKET cho ${symbol} không khớp KL.`);
        addLog(`[KILL] Đã MỞ ${tradeDirection} ${symbol} | KL: ${actualQty.toFixed(details.quantityPrecision)} | Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);
        return { symbol, quantity: actualQty, initialQuantity: actualQty, entryPrice: actualEntry, initialMargin: INITIAL_INVESTMENT_AMOUNT, side: tradeDirection, maxLeverageUsed: maxLeverage, pricePrecision: details.pricePrecision, quantityPrecision: details.quantityPrecision, closedLossAmount: 0, nextPartialCloseLossIndex: 0, pnlBaseForNextMoc: 0, hasAdjustedSLToSpecificLevel: {}, hasClosedAllLossPositionAtLastLevel: false, pairEntryPrice: priceCalc, currentTPId: null, currentSLId: null };
    } catch (err) { addLog(`[KILL] Lỗi mở ${tradeDirection} ${symbol}: ${err.msg}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); return null; }
}

async function setTPAndSLForPosition(position, isFullResetEvent = false) {
    if (!position || position.quantity <= 0 || !position.symbol) return false;
    const details = await getSymbolDetails(position.symbol); if(!details) { addLog(`[KILL] Không có details cho ${position.symbol} để đặt TP/SL`); return false;}
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity, pnlBaseForNextMoc = 0 } = position;
    addLog(`[KILL] Đặt/Reset TP/SL ${side} ${symbol} (Entry: ${entryPrice.toFixed(pricePrecision)}, KL: ${quantity.toFixed(position.quantityPrecision)}, PNL Base: ${pnlBaseForNextMoc.toFixed(2)}%)...`);
    try {
        let TP_MULT, SL_MULT, steps = [];
        if (maxLeverageUsed >= 75) { TP_MULT = 10; SL_MULT = 6; for (let i = 1; i <= 8; i++) steps.push(i * 100); }
        else if (maxLeverageUsed >= 50) { TP_MULT = 5; SL_MULT = 3; for (let i = 1; i <= 8; i++) steps.push(i * 50); }
        else { TP_MULT = 3.5; SL_MULT = 2; for (let i = 1; i <= 8; i++) steps.push(i * 35); }
        const pnlBaseUSD = (initialMargin * pnlBaseForNextMoc) / 100;
        const targetPnlTP_USD = (initialMargin * TP_MULT) + pnlBaseUSD;
        const targetPnlSL_USD = -(initialMargin * SL_MULT) + pnlBaseUSD;
        const priceChangeTP = targetPnlTP_USD / initialQuantity;
        const priceChangeSL = Math.abs(targetPnlSL_USD) / initialQuantity;
        let tpPx = parseFloat((side === 'LONG' ? entryPrice + priceChangeTP : entryPrice - priceChangeTP).toFixed(pricePrecision));
        let slPx = parseFloat((side === 'LONG' ? entryPrice - priceChangeSL : entryPrice + priceChangeSL).toFixed(pricePrecision));
        if (side === 'LONG') { if (slPx >= tpPx && tpPx > entryPrice) slPx = parseFloat((tpPx - details.tickSize).toFixed(pricePrecision)); else if (slPx >= entryPrice && targetPnlSL_USD < 0) slPx = parseFloat((entryPrice - details.tickSize).toFixed(pricePrecision)); if (tpPx <= entryPrice && targetPnlTP_USD > 0) tpPx = parseFloat((entryPrice + details.tickSize).toFixed(pricePrecision)); }
        else { if (slPx <= tpPx && tpPx < entryPrice) slPx = parseFloat((tpPx + details.tickSize).toFixed(pricePrecision)); else if (slPx <= entryPrice && targetPnlSL_USD < 0) slPx = parseFloat((entryPrice + details.tickSize).toFixed(pricePrecision)); if (tpPx >= entryPrice && targetPnlTP_USD > 0) tpPx = parseFloat((entryPrice - details.tickSize).toFixed(pricePrecision)); }
        const orderSide = (side === 'LONG') ? 'SELL' : 'BUY'; if (quantity <= 0) return false;
        const slOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET', stopPrice: slPx, quantity, timeInForce: 'GTC', closePosition: true, newClientOrderId: `KILL-SL-${side}-${Date.now()}` });
        const tpOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPx, quantity, timeInForce: 'GTC', closePosition: true, newClientOrderId: `KILL-TP-${side}-${Date.now()}` });
        position.currentTPId = tpOrd.orderId; position.currentSLId = slOrd.orderId;
        if (!position.partialCloseLossLevels || position.partialCloseLossLevels.length === 0) position.partialCloseLossLevels = steps;
        if (isFullResetEvent) { position.nextPartialCloseLossIndex = 0; position.hasAdjustedSLToSpecificLevel = {}; position.hasClosedAllLossPositionAtLastLevel = false; }
        if (typeof position.pnlBaseForNextMoc !== 'number') position.pnlBaseForNextMoc = 0;
        return true;
    } catch (err) { addLog(`[KILL] Lỗi đặt TP/SL ${side} ${symbol}: ${err.msg}.`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); return false; }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade || quantityToClose <=0 || !position.symbol) return false;
    isProcessingTrade = true;
    try {
        const details = await getSymbolDetails(position.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol ${position.symbol}.`);
        let qtyEff = Math.min(quantityToClose, position.quantity);
        qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qtyEff <= 0) { isProcessingTrade = false; return false; }
        const side = (position.side === 'LONG') ? 'SELL' : 'BUY';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side, positionSide: position.side, type: 'MARKET', quantity: qtyEff, newClientOrderId: `KILL-PARTIAL-${position.side}-${Date.now()}`});
        position.closedLossAmount += qtyEff; position.quantity -= qtyEff;
        if (position.quantity < details.stepSize) position.quantity = 0;
        addLog(`[KILL] Đóng ${qtyEff.toFixed(details.quantityPrecision)} ${position.side} ${position.symbol}. Còn: ${position.quantity.toFixed(details.quantityPrecision)}`);
        if (position.quantity > 0) {
            if(position.currentTPId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentTPId});} catch(e){}
            if(position.currentSLId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentSLId});} catch(e){}
            await sleep(300); await setTPAndSLForPosition(position, false);
        } else { if (position.side === 'LONG') currentLongPosition = null; else currentShortPosition = null; }
        isProcessingTrade = false; return true;
    } catch (err) { addLog(`[KILL] Lỗi đóng từng phần ${position.side} ${position.symbol}: ${err.msg}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError) && !(err && err.code && err.code <0 && err.code !== -2011)) isProcessingTrade = false; }
}

async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!positionToModify || quantityToAdd <= 0 || isProcessingTrade || !positionToModify.symbol) return false;
    isProcessingTrade = true;
    try {
        const details = await getSymbolDetails(positionToModify.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol ${positionToModify.symbol}.`);
        let qtyEff = quantityToAdd;
        if (reasonForAdd !== "kill_mode_reopen_closed_losing_pos") {
            const qtyBot = positionToModify.quantity; const maxAdd = positionToModify.initialQuantity - qtyBot;
            if (maxAdd <= 0 && reasonForAdd !== "kill_to_sideways_reopen_losing") { isProcessingTrade = false; return false; }
            qtyEff = Math.min(qtyEff, maxAdd);
            if (reasonForAdd === "kill_to_sideways_reopen_losing") { qtyEff = Math.max(0, positionToModify.initialQuantity - qtyBot); }
        }
        qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qtyEff <= 0) { isProcessingTrade = false; return false; }
        const side = (positionToModify.side === 'LONG') ? 'BUY' : 'SELL';
        addLog(`[KILL] Mở thêm ${qtyEff.toFixed(details.quantityPrecision)} ${positionToModify.symbol} cho ${positionToModify.side} (Lý do: ${reasonForAdd}).`);
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol: positionToModify.symbol, side, positionSide: positionToModify.side, type: 'MARKET', quantity: qtyEff, newClientOrderId: `KILL-ADD-${positionToModify.side}-${Date.now()}`});
        positionToModify.closedLossAmount -= qtyEff; if (positionToModify.closedLossAmount < 0) positionToModify.closedLossAmount = 0;
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
        const otherP = (positionToModify.side === 'LONG') ? currentShortPosition : currentLongPosition;
        if (reasonForAdd === "sideways_moc5_reopen" && otherP) { otherP.pnlBaseForNextMoc = (otherP.unrealizedPnl / otherP.initialMargin) * 100; otherP.nextPartialCloseLossIndex = 0; otherP.hasAdjustedSLToSpecificLevel = {}; }
        else if (reasonForAdd === "price_near_pair_entry_reopen") { positionToModify.pnlBaseForNextMoc = 0; positionToModify.nextPartialCloseLossIndex = 0; }
        else if (reasonForAdd === "kill_mode_reopen_closed_losing_pos") { positionToModify.pnlBaseForNextMoc = 0; positionToModify.nextPartialCloseLossIndex = 0; if (otherP) { otherP.pnlBaseForNextMoc = (otherP.unrealizedPnl / otherP.initialMargin) * 100; otherP.nextPartialCloseLossIndex = 0; otherP.hasAdjustedSLToSpecificLevel = {}; } }
        const newPairEntry = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (newPairEntry) { if (currentLongPosition) currentLongPosition.pairEntryPrice = newPairEntry; if (currentShortPosition) currentShortPosition.pairEntryPrice = newPairEntry; }
        await sleep(2000);
        const updatedPos = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        if (currentLongPosition) { const lpEx = updatedPos.find(p => p.symbol === currentLongPosition.symbol && p.positionSide === 'LONG'); if (lpEx) { currentLongPosition.quantity = Math.abs(parseFloat(lpEx.positionAmt)); currentLongPosition.entryPrice = parseFloat(lpEx.entryPrice); } }
        if (currentShortPosition) { const spEx = updatedPos.find(p => p.symbol === currentShortPosition.symbol && p.positionSide === 'SHORT'); if (spEx) { currentShortPosition.quantity = Math.abs(parseFloat(spEx.positionAmt)); currentShortPosition.entryPrice = parseFloat(spEx.entryPrice); } }
        let tpslOk = true;
        if (currentLongPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslOk = false; await sleep(300); }
        if (currentShortPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslOk = false; }
        if (!tpslOk) addLog(`[KILL] Lỗi đặt lại TP/SL sau khi thêm vị thế cho ${TARGET_COIN_SYMBOL}.`);
        isProcessingTrade = false; return true;
    } catch (err) { addLog(`[KILL] Lỗi mở lại lệnh ${positionToModify.side} ${positionToModify.symbol}: ${err.msg}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError) && !(err && err.code && err.code <0 && err.code !== -2011)) isProcessingTrade = false; }
}

async function openGridPositionAndSetTPSL(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    if(!symbol) return null;
    addLog(`[LƯỚI] Mở lệnh ${tradeDirection} ${symbol} bước ${stepIndex}, giá mục tiêu ~${entryPriceToTarget.toFixed(4)}`);
    try {
        const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol ${symbol} cho lệnh lưới.`);
        const maxLev = await getLeverageBracketForSymbol(symbol); if (!maxLev) throw new Error(`Không lấy được đòn bẩy cho lệnh lưới ${symbol}.`);
        if (!await setLeverage(symbol, maxLev)) throw new Error(`Lỗi đặt đòn bẩy cho ${symbol}.`); await sleep(200);
        let qty = (INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO * maxLev) / entryPriceToTarget;
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qty * entryPriceToTarget < details.minNotional) throw new Error(`Giá trị lệnh lưới quá nhỏ cho ${symbol}.`);
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const marketOrderRes = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
        const actualEntry = parseFloat(marketOrderRes.avgPrice); const actualQty = parseFloat(marketOrderRes.executedQty);
        if (actualQty === 0) throw new Error(`Lệnh lưới MARKET cho ${symbol} không khớp KL.`);
        addLog(`[LƯỚI] Đã MỞ ${tradeDirection} ${symbol} KL: ${actualQty.toFixed(details.quantityPrecision)}, Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);
        const gridPos = { id: marketOrderRes.orderId, symbol, side: tradeDirection, entryPrice: actualEntry, quantity: actualQty, tpOrderId: null, slOrderId: null, originalAnchorPrice: sidewaysGrid.anchorPrice, stepIndex };
        let tpVal = actualEntry * (1 + (tradeDirection === 'LONG' ? SIDEWAYS_TP_PERCENT_FROM_ENTRY : -SIDEWAYS_TP_PERCENT_FROM_ENTRY));
        let slVal = actualEntry * (1 - (tradeDirection === 'LONG' ? SIDEWAYS_SL_PERCENT_FROM_ENTRY : -SIDEWAYS_SL_PERCENT_FROM_ENTRY));
        tpVal = parseFloat(tpVal.toFixed(details.pricePrecision)); slVal = parseFloat(slVal.toFixed(details.pricePrecision));
        const tpslSide = (tradeDirection === 'LONG') ? 'SELL' : 'BUY';
        try { const tpOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: tpslSide, positionSide: tradeDirection, type: 'TAKE_PROFIT_MARKET', stopPrice: tpVal, quantity: actualQty, timeInForce: 'GTC', closePosition: true, newClientOrderId: `GRID-TP-${tradeDirection[0]}${stepIndex}-${Date.now()}` }); gridPos.tpOrderId = tpOrd.orderId; } catch (e) { addLog(`[LƯỚI] LỖI đặt TP ${tradeDirection} ${symbol} @${actualEntry.toFixed(4)}: ${e.msg}`); }
        try { const slOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: tpslSide, positionSide: tradeDirection, type: 'STOP_MARKET', stopPrice: slVal, quantity: actualQty, timeInForce: 'GTC', closePosition: true, newClientOrderId: `GRID-SL-${tradeDirection[0]}${stepIndex}-${Date.now()}` }); gridPos.slOrderId = slOrd.orderId; } catch (e) { addLog(`[LƯỚI] LỖI đặt SL ${tradeDirection} ${symbol} @${actualEntry.toFixed(4)}: ${e.msg}`); }
        sidewaysGrid.activeGridPositions.push(gridPos); return gridPos;
    } catch (err) { addLog(`[LƯỚI] LỖI MỞ LỆNH ${tradeDirection} ${symbol}: ${err.msg || err.message}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); return null; }
}

async function closeSpecificGridPosition(gridPosObj, reasonForClose, isSlEvent = false, isTpEvent = false) {
    if (!gridPosObj || !gridPosObj.symbol) return;
    addLog(`[LƯỚI] Đóng lệnh ${gridPosObj.side} ${gridPosObj.symbol} ID ${gridPosObj.id} @${gridPosObj.entryPrice.toFixed(4)}. Lý do: ${reasonForClose}`);
    if (gridPosObj.tpOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: gridPosObj.symbol, orderId: gridPosObj.tpOrderId }); } catch (e) { if (e.code !== -2011) addLog(`[LƯỚI] Lỗi hủy TP ${gridPosObj.tpOrderId}: ${e.msg}`);}}
    if (gridPosObj.slOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: gridPosObj.symbol, orderId: gridPosObj.slOrderId }); } catch (e) { if (e.code !== -2011) addLog(`[LƯỚI] Lỗi hủy SL ${gridPosObj.slOrderId}: ${e.msg}`);}}
    await sleep(300);
    if (!isSlEvent && !isTpEvent) {
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: gridPosObj.symbol });
            const posOnEx = positions.find(p => p.symbol === gridPosObj.symbol && p.positionSide === gridPosObj.side && Math.abs(parseFloat(p.positionAmt)) >= gridPosObj.quantity * 0.9);
            if (posOnEx) {
                const qtyClose = Math.abs(parseFloat(posOnEx.positionAmt));
                if (qtyClose > 0) { const sideClose = gridPosObj.side === 'LONG' ? 'SELL' : 'BUY'; await callSignedAPI('/fapi/v1/order', 'POST', { symbol: gridPosObj.symbol, side: sideClose, positionSide: gridPosObj.side, type: 'MARKET', quantity: qtyClose }); }
            }
        } catch (err) { addLog(`[LƯỚI] Lỗi MARKET đóng ${gridPosObj.side} ${gridPosObj.symbol} ID ${gridPosObj.id}: ${err.msg}`); }
    }
    sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== gridPosObj.id);
    if (isSlEvent) sidewaysGrid.sidewaysStats.slMatchedCount++; if (isTpEvent) sidewaysGrid.sidewaysStats.tpMatchedCount++;
}

async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || isProcessingTrade || sidewaysGrid.isClearingForKillSwitch || !TARGET_COIN_SYMBOL) return;
    const posFromAnchor = sidewaysGrid.activeGridPositions.filter(p => p.originalAnchorPrice === sidewaysGrid.anchorPrice);
    if (posFromAnchor.length === 0) {
        let side = null, targetEntry = null;
        if (currentMarketPrice >= sidewaysGrid.anchorPrice * (1 + SIDEWAYS_INITIAL_TRIGGER_PERCENT)) { side = 'SHORT'; targetEntry = sidewaysGrid.anchorPrice * (1 + SIDEWAYS_INITIAL_TRIGGER_PERCENT); }
        else if (currentMarketPrice <= sidewaysGrid.anchorPrice * (1 - SIDEWAYS_INITIAL_TRIGGER_PERCENT)) { side = 'LONG'; targetEntry = sidewaysGrid.anchorPrice * (1 - SIDEWAYS_INITIAL_TRIGGER_PERCENT); }
        if (side) { await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, side, targetEntry, 0); }
    }
    const MAX_STEPS = Math.floor(SIDEWAYS_GRID_RANGE_PERCENT / SIDEWAYS_GRID_STEP_PERCENT);
    for (let i = 1; i <= MAX_STEPS; i++) {
        const shortTrig = sidewaysGrid.anchorPrice * (1 + i * SIDEWAYS_GRID_STEP_PERCENT);
        if (currentMarketPrice >= shortTrig && !sidewaysGrid.activeGridPositions.find(p => p.side === 'SHORT' && p.stepIndex === i && p.originalAnchorPrice === sidewaysGrid.anchorPrice)) {
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, 'SHORT', shortTrig, i);
        }
        const longTrig = sidewaysGrid.anchorPrice * (1 - i * SIDEWAYS_GRID_STEP_PERCENT);
        if (currentMarketPrice <= longTrig && !sidewaysGrid.activeGridPositions.find(p => p.side === 'LONG' && p.stepIndex === i && p.originalAnchorPrice === sidewaysGrid.anchorPrice)) {
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, 'LONG', longTrig, i);
        }
    }
    if (currentMarketPrice > sidewaysGrid.gridUpperLimit || currentMarketPrice < sidewaysGrid.gridLowerLimit) {
        sidewaysGrid.anchorPrice = currentMarketPrice;
        sidewaysGrid.gridUpperLimit = sidewaysGrid.anchorPrice * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
        sidewaysGrid.gridLowerLimit = sidewaysGrid.anchorPrice * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
        sidewaysGrid.lastGridMoveTime = Date.now();
    }
    if (Date.now() - sidewaysGrid.lastVolatilityCheckTime > VOLATILITY_CHECK_INTERVAL_MS) {
        sidewaysGrid.lastVolatilityCheckTime = Date.now();
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
        if (lastCalculatedVolatility >= OVERALL_VOLATILITY_THRESHOLD) {
            addLog(`[LƯỚI] ${TARGET_COIN_SYMBOL} chuyển sang chế độ KILL do biến động mạnh (${lastCalculatedVolatility.toFixed(2)}%).`);
            if (!sidewaysGrid.isClearingForKillSwitch) {
                sidewaysGrid.isClearingForKillSwitch = true;
                await closeAllSidewaysPositionsAndOrders(`Chuyển sang KILL (${TARGET_COIN_SYMBOL}) do biến động mạnh`);
                if(sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout);
                sidewaysGrid.killSwitchDelayTimeout = setTimeout(async () => {
                    addLog(`[LƯỚI] Hết ${KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS/1000}s chờ. Kích hoạt KILL mode cho ${TARGET_COIN_SYMBOL}.`);
                    currentBotMode = 'kill'; sidewaysGrid.isClearingForKillSwitch = false;
                    if (currentLongPosition) currentLongPosition = null; if (currentShortPosition) currentShortPosition = null;
                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                    if (botRunning) scheduleNextMainCycle();
                }, KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS);
            }
            return;
        }
    }
}

async function closeAllSidewaysPositionsAndOrders(reason) {
    if (!TARGET_COIN_SYMBOL) return;
    addLog(`[LƯỚI] Đóng tất cả vị thế Sideways cho ${TARGET_COIN_SYMBOL}. Lý do: ${reason}`);
    const activeCopy = [...sidewaysGrid.activeGridPositions];
    for (const pos of activeCopy) {
        if (pos.tpOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.tpOrderId }); } catch (e) {} }
        if (pos.slOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.slOrderId }); } catch (e) {} }
    }
    await sleep(500);
    for (const pos of activeCopy) { await closeSpecificGridPosition(pos, `Đóng toàn bộ (${TARGET_COIN_SYMBOL}): ${reason}`); await sleep(300); }
    sidewaysGrid.isActive = false; sidewaysGrid.anchorPrice = null;
    sidewaysGrid.activeGridPositions = [];
}

async function checkOverallTPSL() {
    if (!botRunning) return false;
    let stopReason = null;
    if (targetOverallTakeProfit > 0 && netPNL >= targetOverallTakeProfit) {
        stopReason = `Chốt lời toàn bộ bot (coin ${TARGET_COIN_SYMBOL}) đạt ${targetOverallTakeProfit} USDT (PNL Ròng: ${netPNL.toFixed(2)} USDT).`;
    } else if (targetOverallStopLoss < 0 && netPNL <= targetOverallStopLoss) {
        stopReason = `Cắt lỗ toàn bộ bot (coin ${TARGET_COIN_SYMBOL}) đạt ${targetOverallStopLoss} USDT (PNL Ròng: ${netPNL.toFixed(2)} USDT).`;
    }

    if (stopReason) {
        addLog(stopReason + " Đang dừng bot...");
        await stopBotLogicInternal();
        return true;
    }
    return false;
}

async function runTradingLogic() {
    if (!botRunning || sidewaysGrid.isClearingForKillSwitch) return;
    if (await checkOverallTPSL()) return;

    if (!TARGET_COIN_SYMBOL || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive)) {
        addLog(`TARGET_COIN_SYMBOL chưa được đặt (${TARGET_COIN_SYMBOL}) hoặc không có lệnh/lưới. Đang chọn coin mới...`);
        const newCoin = await selectTargetCoin();
        if (newCoin) {
            if (TARGET_COIN_SYMBOL !== newCoin) {
                addLog(`TARGET_COIN_SYMBOL thay đổi từ ${TARGET_COIN_SYMBOL || 'N/A'} sang ${newCoin}`);
                if (TARGET_COIN_SYMBOL) {
                    await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                }
                TARGET_COIN_SYMBOL = newCoin;
                totalProfit = 0; totalLoss = 0; netPNL = 0;
                lastCalculatedVolatility = 0;
                if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
                setupMarketDataStream(TARGET_COIN_SYMBOL);
            }
        } else {
            addLog("Không chọn được coin mục tiêu. Bot sẽ thử lại sau 1 phút.");
            if (botRunning) scheduleNextMainCycle(60000);
            return;
        }
    }
    if (!TARGET_COIN_SYMBOL) {
        addLog("Lỗi nghiêm trọng: TARGET_COIN_SYMBOL vẫn là null. Dừng chu kỳ, thử lại sau 1 phút.");
        if (botRunning) scheduleNextMainCycle(60000);
        return;
    }

    if (currentBotMode === 'sideways' && sidewaysGrid.isActive && Date.now() - lastCoinSwitchCheckTime > COIN_SWITCH_CHECK_INTERVAL_MS) {
        lastCoinSwitchCheckTime = Date.now();
        addLog(`Đang ở Sideways (${TARGET_COIN_SYMBOL}). Kiểm tra coin biến động cao từ VPS1...`);
        const topCoins = await fetchTopCoinsFromVPS1();
        const volatileCoins = topCoins.filter(c => Math.abs(c.changePercent) >= VOLATILITY_SWITCH_THRESHOLD_PERCENT && c.symbol !== TARGET_COIN_SYMBOL);

        if (volatileCoins.length > 0) {
            addLog(`Tìm thấy ${volatileCoins.length} coin biến động mạnh: ${volatileCoins.map(c=>c.symbol).join(', ')}. Áp dụng delay ${VPS_SPECIFIC_DELAY_MS}ms...`);
            await sleep(VPS_SPECIFIC_DELAY_MS);

            const freshTopCoins = await fetchTopCoinsFromVPS1();
            const freshVolatileCoins = freshTopCoins.filter(c => Math.abs(c.changePercent) >= VOLATILITY_SWITCH_THRESHOLD_PERCENT && c.symbol !== TARGET_COIN_SYMBOL);
            let bestNewCoinInfo = null;
            for (const coin of freshVolatileCoins) {
                const hasPosition = await checkExistingPosition(coin.symbol);
                await sleep(300);
                if (!hasPosition) {
                    bestNewCoinInfo = coin; break;
                } else { addLog(`Coin ${coin.symbol} đã có vị thế sau delay. Bỏ qua.`); }
            }

            if (bestNewCoinInfo && bestNewCoinInfo.symbol !== TARGET_COIN_SYMBOL) {
                addLog(`Quyết định chuyển từ ${TARGET_COIN_SYMBOL} sang ${bestNewCoinInfo.symbol} (${bestNewCoinInfo.changePercent}%). Đóng lệnh Sideways.`);
                await closeAllSidewaysPositionsAndOrders(`Chuyển sang coin mới ${bestNewCoinInfo.symbol} do biến động cao.`);
                TARGET_COIN_SYMBOL = bestNewCoinInfo.symbol;
                sidewaysGrid.isActive = false;
                totalProfit = 0; totalLoss = 0; netPNL = 0;
                lastCalculatedVolatility = 0;
                if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
                setupMarketDataStream(TARGET_COIN_SYMBOL);
                if (botRunning) scheduleNextMainCycle(1000);
                return;
            } else { addLog("Không có coin mới phù hợp để chuyển sau delay."); }
        }
    }

    await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
    const prevMode = currentBotMode;

    if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD && !sidewaysGrid.isActive && !currentLongPosition && !currentShortPosition) {
        currentBotMode = 'sideways';
    } else if (lastCalculatedVolatility > OVERALL_VOLATILITY_THRESHOLD && currentBotMode === 'sideways' && sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) {
        // Để manageSidewaysGridLogic xử lý
    } else if (lastCalculatedVolatility > OVERALL_VOLATILITY_THRESHOLD && currentBotMode !== 'kill' && !sidewaysGrid.isClearingForKillSwitch) {
        if (sidewaysGrid.isActive) { /* manageSidewaysGridLogic xử lý */ }
        else { currentBotMode = 'kill'; }
    }
    
    if (prevMode !== currentBotMode && !sidewaysGrid.isClearingForKillSwitch) {
        addLog(`Chế độ thay đổi từ ${prevMode.toUpperCase()} sang ${currentBotMode.toUpperCase()} (Vol ${TARGET_COIN_SYMBOL} 1h qua: ${lastCalculatedVolatility.toFixed(2)}%)`);
    }

    if (currentBotMode === 'sideways') {
        if (!sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) {
            if (!currentLongPosition && !currentShortPosition) {
                addLog(`[LƯỚI] Kích hoạt chế độ Sideways cho ${TARGET_COIN_SYMBOL}.`);
                const priceAnchor = await getCurrentPrice(TARGET_COIN_SYMBOL);
                if (!priceAnchor) { if(botRunning) scheduleNextMainCycle(); return; }
                sidewaysGrid.isActive = true; sidewaysGrid.anchorPrice = priceAnchor;
                sidewaysGrid.gridUpperLimit = priceAnchor * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
                sidewaysGrid.gridLowerLimit = priceAnchor * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
                sidewaysGrid.lastGridMoveTime = Date.now(); sidewaysGrid.lastVolatilityCheckTime = Date.now();
                sidewaysGrid.activeGridPositions = []; sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                if (!positionCheckInterval) {
                     positionCheckInterval = setInterval(async () => {
                         if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
                             try { await manageOpenPosition(); }
                             catch (e) { if(e instanceof CriticalApiError) await stopBotLogicInternal(); }
                         } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                             clearInterval(positionCheckInterval); positionCheckInterval = null;
                         }
                     }, VOLATILITY_CHECK_INTERVAL_MS);
                }
            } else { if(botRunning) scheduleNextMainCycle(); }
        }
    }

    if (currentBotMode === 'kill') {
        if (currentLongPosition || currentShortPosition || (sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch)) {
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        if (sidewaysGrid.isClearingForKillSwitch) {
             if (botRunning) scheduleNextMainCycle(); return;
        }
        
        addLog(`Bắt đầu chu kỳ giao dịch KILL mới cho ${TARGET_COIN_SYMBOL}...`);
        try {
            const maxLev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL); if (!maxLev) { if (botRunning) scheduleNextMainCycle(); return; }
            const priceNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!priceNewPair) { if (botRunning) scheduleNextMainCycle(); return; }
            currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLev, priceNewPair); if (!currentLongPosition) { if (botRunning) scheduleNextMainCycle(); return; }
            await sleep(800);
            currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLev, priceNewPair);
            if (!currentShortPosition) { if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT', 'LONG'); currentLongPosition = null; if (botRunning) scheduleNextMainCycle(); return; }
            await sleep(1000); await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
            let tpslSet = true;
            if (currentLongPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslSet = false; }
            await sleep(300);
            if (currentShortPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslSet = false; }
            if (!tpslSet) { if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi TP/SL Kill', 'LONG'); if (currentShortPosition) await closePosition(currentShortPosition.symbol, 'Lỗi TP/SL Kill', 'SHORT'); await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return; }
            if (!positionCheckInterval) {
                 positionCheckInterval = setInterval(async () => {
                     if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
                         try { await manageOpenPosition(); }
                         catch (e) { if(e instanceof CriticalApiError) await stopBotLogicInternal(); }
                     } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                         clearInterval(positionCheckInterval); positionCheckInterval = null;
                     }
                 }, VOLATILITY_CHECK_INTERVAL_MS);
            }
        } catch (err) { if(err instanceof CriticalApiError) await stopBotLogicInternal(); if(botRunning) scheduleNextMainCycle(); }
    } else {
        if(botRunning && currentBotMode !== 'sideways') scheduleNextMainCycle();
    }
}

const manageOpenPosition = async () => {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForKillSwitch || !TARGET_COIN_SYMBOL) return;
    if (await checkOverallTPSL()) return;

    if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
        if (Date.now() - (sidewaysGrid.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS) {
            sidewaysGrid.lastVolatilityCheckTime = Date.now();
            await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
            if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD) {
                addLog(`[KILL] Biến động ${TARGET_COIN_SYMBOL} giảm (${lastCalculatedVolatility.toFixed(2)}%), chuyển sang SIDEWAYS.`);
                currentBotMode = 'sideways';
                if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển Sideways (${TARGET_COIN_SYMBOL} vol giảm)`, "LONG");
                if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển Sideways (${TARGET_COIN_SYMBOL} vol giảm)`, "SHORT");
                currentLongPosition = null; currentShortPosition = null;
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                sidewaysGrid.isActive = false;
                scheduleNextMainCycle(1000);
                return;
            }
        }
    }

    if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        await manageSidewaysGridLogic();
    } else if (currentBotMode === 'kill') {
        if (!currentLongPosition || !currentShortPosition) { if (!currentLongPosition && !currentShortPosition && botRunning) { await cleanupAndResetCycle(TARGET_COIN_SYMBOL); } return; }
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            let longPosEx = positions.find(p => p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0);
            let shortPosEx = positions.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (!longPosEx && currentLongPosition) { currentLongPosition.quantity = 0; currentLongPosition = null; }
            if (!shortPosEx && currentShortPosition) { currentShortPosition.quantity = 0; currentShortPosition = null; }
            if (!currentLongPosition || !currentShortPosition) { if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return; }
            if (longPosEx && currentLongPosition) { currentLongPosition.unrealizedPnl = parseFloat(longPosEx.unRealizedProfit); currentLongPosition.currentPrice = parseFloat(longPosEx.markPrice); currentLongPosition.quantity = Math.abs(parseFloat(longPosEx.positionAmt));}
            if (shortPosEx && currentShortPosition) { currentShortPosition.unrealizedPnl = parseFloat(shortPosEx.unRealizedProfit); currentShortPosition.currentPrice = parseFloat(shortPosEx.markPrice); currentShortPosition.quantity = Math.abs(parseFloat(shortPosEx.positionAmt));}
            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
            else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
            else { 
                if (currentLongPosition && currentShortPosition && currentLongPosition.partialCloseLossLevels && currentShortPosition.partialCloseLossLevels) {
                    const posChk = currentLongPosition.unrealizedPnl > currentShortPosition.unrealizedPnl ? currentLongPosition : currentShortPosition; const otherP = posChk === currentLongPosition ? currentShortPosition : currentLongPosition;
                    if (otherP.quantity === 0 && otherP.hasClosedAllLossPositionAtLastLevel) {
                        const pnlPctChk = (posChk.unrealizedPnl / posChk.initialMargin) * 100; const pnlBaseChk = posChk.pnlBaseForNextMoc || 0; const MOC5_IDX = 4; const moc5RelPnl = posChk.partialCloseLossLevels[MOC5_IDX];
                        if (moc5RelPnl !== undefined) {
                            const threshMoc5 = pnlBaseChk + moc5RelPnl;
                            if (pnlPctChk >= threshMoc5 && posChk.nextPartialCloseLossIndex > MOC5_IDX) {
                                    addLog(`[KILL REOPEN] ${posChk.side} ${TARGET_COIN_SYMBOL} về Mốc 5. Mở lại ${otherP.side}.`);
                                    const reopenedLosing = await openMarketPosition(TARGET_COIN_SYMBOL, otherP.side, otherP.maxLeverageUsed, await getCurrentPrice(TARGET_COIN_SYMBOL));
                                    if (reopenedLosing) {
                                        if (otherP.side === 'LONG') currentLongPosition = reopenedLosing; else currentShortPosition = reopenedLosing;
                                        posChk.pnlBaseForNextMoc = pnlPctChk; posChk.nextPartialCloseLossIndex = 0; posChk.hasAdjustedSLToSpecificLevel = {};
                                        reopenedLosing.pnlBaseForNextMoc = 0; reopenedLosing.nextPartialCloseLossIndex = 0;
                                        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                                        if (currentLongPosition?.quantity > 0) await setTPAndSLForPosition(currentLongPosition, true); await sleep(300);
                                        if (currentShortPosition?.quantity > 0) await setTPAndSLForPosition(currentShortPosition, true);
                                        return; 
                                    }
                            }
                        }
                    }
                }
                return; 
            }
            if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0) {
                const pnlPctWin = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100; const pnlBaseWin = winningPos.pnlBaseForNextMoc || 0; const targetMocRelPnl = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
                if (typeof targetMocRelPnl === 'undefined') return;
                const absThreshMoc = pnlBaseWin + targetMocRelPnl; const MOC5_IDX = 4, MOC5_REL_PNL = winningPos.partialCloseLossLevels[MOC5_IDX]; const MOC8_IDX = 7, MOC8_REL_PNL = winningPos.partialCloseLossLevels[MOC8_IDX];
                if (MOC5_REL_PNL === undefined || MOC8_REL_PNL === undefined) { addLog(`Lỗi: partialCloseLossLevels không đúng cho ${TARGET_COIN_SYMBOL}.`); return; }
                let actionTaken = false;
                if (pnlPctWin >= absThreshMoc) {
                    actionTaken = true; const mocIdxReached = winningPos.nextPartialCloseLossIndex;
                    let qtyFrac = (mocIdxReached === MOC5_IDX) ? 0.20 : (mocIdxReached >= MOC8_IDX) ? 1.00 : 0.10;
                    if(await closePartialPosition(losingPos, qtyFrac === 1.00 ? losingPos.quantity : losingPos.initialQuantity * qtyFrac)) { winningPos.nextPartialCloseLossIndex++; }
                    if (mocIdxReached === MOC5_IDX && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL]) {
                        const lossPctSL = MOC8_REL_PNL / 100; const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100; const targetPnlSLLUSD = -(losingPos.initialMargin * lossPctSL) + pnlBaseLosingUSD; const priceChangeSL = Math.abs(targetPnlSLLUSD) / losingPos.initialQuantity; const slPrice = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeSL : losingPos.entryPrice + priceChangeSL).toFixed(losingPos.pricePrecision));
                        if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); } catch(e){} }
                        const newSL = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: losingPos.symbol, side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: losingPos.side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: losingPos.quantity, timeInForce: 'GTC', closePosition: true });
                        if (newSL.orderId) { losingPos.currentSLId = newSL.orderId; winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL] = true; addLog(`SL lệnh lỗ ${losingPos.side} ${TARGET_COIN_SYMBOL} rời về ${slPrice.toFixed(losingPos.pricePrecision)}`); }
                    }
                    if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > MOC8_IDX && actionTaken) ) { losingPos.hasClosedAllLossPositionAtLastLevel = true; }
                }
                const absPnlThreshMoc8 = (winningPos.pnlBaseForNextMoc || 0) + MOC8_REL_PNL;
                if (pnlPctWin >= absPnlThreshMoc8 && !losingPos.hasClosedAllLossPositionAtLastLevel && losingPos.quantity > 0 && !actionTaken) {
                     await closePosition(losingPos.symbol, `Đóng nốt ở Mốc 8 lãi lệnh thắng (Kill ${TARGET_COIN_SYMBOL})`, losingPos.side);
                     if (losingPos) { losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; }
                }
            }
            if (losingPos?.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos?.quantity > 0) {
                const pairEntry = winningPos.pairEntryPrice; const tol = (pairEntry || currentMarketPrice || 0) * 0.0005;
                if (currentMarketPrice && pairEntry && Math.abs(currentMarketPrice - pairEntry) <= tol) {
                    if (!isProcessingTrade) { await addPosition(losingPos, losingPos.closedLossAmount, `price_near_pair_entry_reopen (${TARGET_COIN_SYMBOL})`); }
                }
            }
        } catch (err) { addLog(`Lỗi manageOpenPosition (Kill ${TARGET_COIN_SYMBOL}): ` + (err.msg || err.message)); if(err instanceof CriticalApiError) await stopBotLogicInternal(); }
    }
};

async function processTradeResult(orderInfo) {
    if(isProcessingTrade && orderInfo.X !== 'FILLED') return;
    const wasProc = isProcessingTrade; isProcessingTrade = true;
    const { s: sym, rp: rPnlStr, X: ordStatus, i: ordId, ps: posSide, z: filledQtyStr, S: sideOrd, ap: avgPxStr } = orderInfo;
    const filledQty = parseFloat(filledQtyStr); const rPnl = parseFloat(rPnlStr); const avgPx = parseFloat(avgPxStr);
    
    if (sym !== TARGET_COIN_SYMBOL || ordStatus !== 'FILLED' || filledQty === 0) { if(!wasProc && sym === TARGET_COIN_SYMBOL) isProcessingTrade = false; else if (!wasProc) isProcessingTrade = false; return; }
    addLog(`[Trade FILLED ${TARGET_COIN_SYMBOL}] ID ${ordId} (${posSide} ${sideOrd}) KL ${filledQty.toFixed(4)} @ ${avgPx.toFixed(4)} | PNL Thực Tế: ${rPnl.toFixed(4)}`);
    if (rPnl !== 0) { if (rPnl > 0) totalProfit += rPnl; else totalLoss += Math.abs(rPnl); netPNL = totalProfit - totalLoss; addLog(`PNL Ròng (${TARGET_COIN_SYMBOL}): ${netPNL.toFixed(2)} (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`); }
    if (await checkOverallTPSL()) { if(!wasProc) isProcessingTrade = false; return; }

    if (sidewaysGrid.isActive && TARGET_COIN_SYMBOL === sym) {
        const matchedGrid = sidewaysGrid.activeGridPositions.find(p => p.tpOrderId === ordId || p.slOrderId === ordId);
        if (matchedGrid) {
            const isTp = matchedGrid.tpOrderId === ordId, isSl = matchedGrid.slOrderId === ordId;
            if (isTp) { await closeSpecificGridPosition(matchedGrid, `TP lưới khớp (${TARGET_COIN_SYMBOL})`, false, true); }
            else if (isSl) { await closeSpecificGridPosition(matchedGrid, `SL lưới khớp (${TARGET_COIN_SYMBOL})`, true, false); }
            if(!wasProc) isProcessingTrade = false; return;
        }
    }
    const isLongCloseKill = currentLongPosition && (ordId == currentLongPosition.currentTPId || ordId == currentLongPosition.currentSLId);
    const isShortCloseKill = currentShortPosition && (ordId == currentShortPosition.currentTPId || ordId == currentShortPosition.currentSLId);
    if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === sym && (isLongCloseKill || isShortCloseKill)) {
        const closedSide = posSide; const remainingPos = (closedSide === 'LONG') ? currentShortPosition : currentLongPosition;
        if (closedSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;
        if (rPnl >= 0) {
             if (remainingPos?.quantity > 0) {
                 try { const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPos.symbol }); const qtyEx = Math.abs(parseFloat(positions.find(p => p.symbol === remainingPos.symbol && p.positionSide === remainingPos.side)?.positionAmt || 0)); if (qtyEx > 0) { await closePosition(remainingPos.symbol, `Lãi KILL (${closedSide} ${TARGET_COIN_SYMBOL}) chốt`, remainingPos.side); } }
                 catch(e) { if (e instanceof CriticalApiError) await stopBotLogicInternal(); }
             }
             await cleanupAndResetCycle(sym);
        } else { /* Lệnh lỗ chạy tiếp */ }
    } else if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === sym) {
        await sleep(500);
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            if (currentLongPosition) { const lp = positions.find(p=>p.positionSide==='LONG'); currentLongPosition.quantity=lp?Math.abs(parseFloat(lp.positionAmt)):0; if(currentLongPosition.quantity===0)currentLongPosition=null;}
            if (currentShortPosition) { const sp = positions.find(p=>p.positionSide==='SHORT'); currentShortPosition.quantity=sp?Math.abs(parseFloat(sp.positionAmt)):0; if(currentShortPosition.quantity===0)currentShortPosition=null;}
            if(!currentLongPosition && !currentShortPosition && botRunning) { await cleanupAndResetCycle(TARGET_COIN_SYMBOL); }
        } catch (e) { addLog(`Lỗi cập nhật KL sau partial close Kill (${TARGET_COIN_SYMBOL}): ` + e.message); }
    }
    if(!wasProc) isProcessingTrade = false;
}

async function cleanupAndResetCycle(symbol) {
    if (!symbol) return;
    addLog(`Chu kỳ ${symbol} kết thúc. Dọn dẹp...`);
    if (symbol === TARGET_COIN_SYMBOL && sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) {
         await closeAllSidewaysPositionsAndOrders(`Dọn dẹp chu kỳ cho ${symbol}`);
    }
    else if (sidewaysGrid.isClearingForKillSwitch && symbol === TARGET_COIN_SYMBOL) { /* Đang dọn */ }

    if (symbol === TARGET_COIN_SYMBOL) {
        currentLongPosition = null; currentShortPosition = null;
    }
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    
    await cancelAllOpenOrdersForSymbol(symbol);
    await checkAndHandleRemainingPosition(symbol);

    if (botRunning && !sidewaysGrid.isClearingForKillSwitch) {
        scheduleNextMainCycle(1000);
    }
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.'; if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.';
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime(); await getExchangeInfo();

        TARGET_COIN_SYMBOL = await selectTargetCoin(true);
        if (!TARGET_COIN_SYMBOL) {
            throw new Error("Không thể chọn coin mục tiêu ban đầu.");
        }
        addLog(`Coin mục tiêu ban đầu: ${TARGET_COIN_SYMBOL}`);

        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
        totalProfit=0; totalLoss=0; netPNL=0; currentLongPosition = null; currentShortPosition = null; lastCalculatedVolatility = 0;
        
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey);
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        addLog(`Delay chuyển coin: ${VPS_SPECIFIC_DELAY_MS}ms`);
        scheduleNextMainCycle(1000);
        return 'Bot khởi động thành công.';
    } catch (err) {
        await stopBotLogicInternal();
        const errorMessage = err.msg || err.message || 'Lỗi không xác định khi khởi động';
        addLog(`Lỗi khởi động bot: ${errorMessage}`);
        if (err instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`Sẽ thử khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000} giây.`);
            retryBotTimeout = setTimeout(async () => { retryBotTimeout = null; await startBotLogicInternal(); }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMessage}`;
    }
}

async function stopBotLogicInternal() {
    if (!botRunning && !retryBotTimeout) return 'Bot không chạy.';
    addLog('--- Dừng Bot ---');
    botRunning = false;
    if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout); nextScheduledCycleTimeout = null;
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    if (sidewaysGrid.killSwitchDelayTimeout) { clearTimeout(sidewaysGrid.killSwitchDelayTimeout); sidewaysGrid.killSwitchDelayTimeout = null; }
    
    sidewaysGrid.isActive = false; sidewaysGrid.activeGridPositions = []; sidewaysGrid.isClearingForKillSwitch = false;
    
    if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
    if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.close(); userDataWs = null; }
    
    if (listenKey) {
        try { await callSignedAPI('/fapi/v1/listenKey', 'DELETE', { listenKey }); }
        catch (e) { addLog(`Lỗi xóa listenKey: ${e.message}`); }
        listenKey = null;
    }

    if (TARGET_COIN_SYMBOL) {
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
    }

    currentLongPosition = null; currentShortPosition = null;
    TARGET_COIN_SYMBOL = null;
    lastCoinSwitchCheckTime = 0;
    isProcessingTrade = false; consecutiveApiErrors = 0;
    
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; addLog("Đã hủy retry khởi động bot."); }
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}

async function checkAndHandleRemainingPosition(symbol) {
    if (!symbol) return;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remaining = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remaining.length > 0) {
            addLog(`Tìm thấy ${remaining.length} vị thế sót cho ${symbol}. Đang đóng...`);
            await cancelAllOpenOrdersForSymbol(symbol); await sleep(500);
            for (const pos of remaining) {
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const qtyToClose = Math.abs(parseFloat(pos.positionAmt));
                const closeSideOrder = sideToClose === 'LONG' ? 'SELL' : 'BUY';
                addLog(`Đóng MARKET ${qtyToClose} ${symbol} (${sideToClose}) do dọn dẹp.`);
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: pos.symbol, side: closeSideOrder, positionSide: sideToClose,
                    type: 'MARKET', quantity: qtyToClose
                });
                await sleep(1000);
            }
        }
    } catch (error) { addLog(`Lỗi dọn vị thế sót cho ${symbol}: ${error.message}`); if (error instanceof CriticalApiError) await stopBotLogicInternal(); }
}

function scheduleNextMainCycle(delayMs = 5000) {
    if (!botRunning) return;
    if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = setTimeout(async () => {
        if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
            try {
                await runTradingLogic();
            } catch (e) {
                addLog(`Lỗi trong chu kỳ chính (${TARGET_COIN_SYMBOL || 'N/A'}): ${e.message}`);
                if (e instanceof CriticalApiError) {
                    await stopBotLogicInternal();
                } else if (botRunning) {
                    scheduleNextMainCycle(15000);
                }
            }
        } else if (botRunning) {
             scheduleNextMainCycle(delayMs);
        }
    }, delayMs);
}

async function getListenKey() { try { const r = await callSignedAPI('/fapi/v1/listenKey', 'POST'); return r.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.message}`); return null; } }
async function keepAliveListenKey(key) { try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: key }); } catch (e) { addLog(`Lỗi gia hạn listenKey: ${e.message}`); } }

function setupUserDataStream(key) {
    if (userDataWs && (userDataWs.readyState === WebSocket.OPEN || userDataWs.readyState === WebSocket.CONNECTING)) { userDataWs.close(); }
    const url = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    userDataWs = new WebSocket(url);
    addLog("Đang kết nối User Data Stream...");
    userDataWs.on('open', () => { addLog('User Data Stream đã kết nối.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(() => keepAliveListenKey(key), 30 * 60 * 1000); });
    userDataWs.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(message.o);
            } else if (message.e === 'ACCOUNT_UPDATE') {
                // Xử lý cập nhật tài khoản nếu cần
            }
        } catch (error) { addLog('Lỗi xử lý User Data Stream message: ' + error.message); }
    });
    userDataWs.on('error', (err) => addLog('Lỗi User Data Stream: ' + err.message));
    userDataWs.on('close', (code, reason) => { addLog(`User Data Stream đã đóng. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}. Thử kết nối lại...`); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); if (botRunning) { setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); } });
}

function setupMarketDataStream(symbol) {
    if (!symbol) { addLog("Không có symbol để stream market data."); return; }
    if (marketWs && (marketWs.readyState === WebSocket.OPEN || marketWs.readyState === WebSocket.CONNECTING)) {
        addLog(`Đóng Market Data Stream cũ cho ${marketWs.url.split('/')[marketWs.url.split('/').length-1].split('@')[0].toUpperCase()}...`);
        marketWs.removeAllListeners(); // Xóa hết listener cũ
        marketWs.terminate(); // Đóng ngay lập tức
        marketWs = null;
    }
    const streamName = `${symbol.toLowerCase()}@markPrice@1s`;
    const url = `${WS_BASE_URL}/ws/${streamName}`;
    marketWs = new WebSocket(url);
    addLog(`Đang kết nối Market Data Stream cho ${symbol} (${url})...`);
    marketWs.on('open', () => addLog(`Market Data Stream cho ${symbol} đã kết nối.`));
    marketWs.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.e === 'markPriceUpdate' && message.s === TARGET_COIN_SYMBOL) { // Chỉ xử lý nếu symbol khớp
                currentMarketPrice = parseFloat(message.p);
            }
        } catch (error) { addLog(`Lỗi xử lý Market Data Stream message (${symbol}): ` + error.message); }
    });
    marketWs.on('error', (err) => addLog(`Lỗi Market Data Stream (${symbol}): ` + err.message));
    marketWs.on('close', (code, reason) => {
        addLog(`Market Data Stream (${symbol}) đã đóng. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}.`);
        if (botRunning && symbol === TARGET_COIN_SYMBOL) { // Chỉ kết nối lại nếu bot đang chạy và symbol này vẫn là target
            addLog(`Thử kết nối lại Market Data Stream cho ${TARGET_COIN_SYMBOL} sau 5 giây...`);
            setTimeout(() => setupMarketDataStream(TARGET_COIN_SYMBOL), 5000);
        } else {
             addLog(`Không kết nối lại Market Data Stream cho ${symbol} (Bot dừng hoặc coin đã đổi).`);
        }
    });
}

// --- Express Web Server ---
const app = express(); app.use(express.json());
app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        fs.writeFileSync(htmlPath, fallbackHtmlContent, 'utf8');
    }
    res.sendFile(htmlPath);
});
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) return res.status(500).send('Lỗi đọc log'); const clean = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(clean.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => exec('pm2 jlist', (e, stdout, stderr) => e ? reject(stderr || e.message) : resolve(stdout)));
        const processes = JSON.parse(pm2List);
        const botProc = processes.find(p => p.name === THIS_BOT_PM2_NAME || (p.pm2_env && p.pm2_env.PORT && parseInt(p.pm2_env.PORT) === WEB_SERVER_PORT));
        let statusMsg = `Bot PM2 '${THIS_BOT_PM2_NAME}' (Port ${WEB_SERVER_PORT}) không tìm thấy.`;
        if (botProc) {
            statusMsg = `MÁY CHỦ (PM2 ${botProc.name}): ${botProc.pm2_env.status.toUpperCase()} (Restarts: ${botProc.pm2_env.restart_time})`;
            if (botProc.pm2_env.status === 'online') {
                statusMsg += ` | BOT: ${botRunning ? 'CHẠY' : 'DỪNG'}`;
                if (botStartTime && botRunning) statusMsg += ` | Uptime: ${Math.floor((Date.now() - botStartTime.getTime()) / 60000)}p`;
                statusMsg += ` | ${TARGET_COIN_SYMBOL || "CHƯA CHỌN"} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | Mode: ${currentBotMode.toUpperCase()} (Vol:${lastCalculatedVolatility.toFixed(1)}%)`;
                if(sidewaysGrid.isClearingForKillSwitch) statusMsg += " (ĐANG DỌN SIDEWAYS)";
                let posTxt = "";
                if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
                    posTxt = " | Vị thế KILL: ";
                    if(currentLongPosition) posTxt += `L(${(currentLongPosition.unrealizedPnl || 0).toFixed(1)} PNLb:${(currentLongPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${(currentLongPosition.nextPartialCloseLossIndex || 0) +1}) `;
                    if(currentShortPosition) posTxt += `S(${(currentShortPosition.unrealizedPnl || 0).toFixed(1)} PNLb:${(currentShortPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${(currentShortPosition.nextPartialCloseLossIndex || 0) +1})`;
                } else if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
                    posTxt = ` | Vị thế LƯỚI: ${sidewaysGrid.activeGridPositions.length} lệnh. Anchor: ${sidewaysGrid.anchorPrice?.toFixed(4)}`;
                } else { posTxt = " | Vị thế: --"; }
                statusMsg += posTxt;
            }
        }
        res.send(statusMsg);
    } catch (err) { res.status(500).send(`Lỗi lấy trạng thái PM2: ${err.message}`); }
});
app.get('/api/bot_stats', (req, res) => {
    let killPosData = [];
    if (currentBotMode === 'kill') { [currentLongPosition, currentShortPosition].forEach(p => { if (p) killPosData.push({ type: 'kill', side: p.side, entry: p.entryPrice?.toFixed(p.pricePrecision || 2), qty: p.quantity?.toFixed(p.quantityPrecision || 3), pnl: (p.unrealizedPnl || 0).toFixed(2), curPrice: p.currentPrice?.toFixed(p.pricePrecision || 2), initQty: p.initialQuantity?.toFixed(p.quantityPrecision || 3), closedLoss: p.closedLossAmount?.toFixed(p.quantityPrecision || 3), pairEntry: p.pairEntryPrice?.toFixed(p.pricePrecision || 2), mocIdx: p.nextPartialCloseLossIndex, pnlBase: (p.pnlBaseForNextMoc || 0).toFixed(2) }); }); }
    let gridPosData = [];
    if (sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0) { sidewaysGrid.activeGridPositions.forEach(p => { let pnlUnreal = 0; if (currentMarketPrice && p.entryPrice && p.quantity) { pnlUnreal = (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1); } gridPosData.push({ type: 'grid', side: p.side, entry: p.entryPrice?.toFixed(4), qty: p.quantity?.toFixed(4), curPrice: currentMarketPrice?.toFixed(4), pnl: pnlUnreal.toFixed(2), originalAnchor: p.originalAnchorPrice?.toFixed(4), step: p.stepIndex }); }); }
    res.json({
        success: true,
        data: {
            status: botRunning ? 'CHẠY' : 'DỪNG', mode: currentBotMode.toUpperCase(), vol: lastCalculatedVolatility.toFixed(2),
            profit: totalProfit.toFixed(2), loss: totalLoss.toFixed(2), net: netPNL.toFixed(2),
            positions: killPosData, invest: INITIAL_INVESTMENT_AMOUNT, coin: TARGET_COIN_SYMBOL || "CHƯA CHỌN",
            targetOverallTakeProfit: targetOverallTakeProfit,
            targetOverallStopLoss: targetOverallStopLoss,
            sidewaysGridInfo: { isActive: sidewaysGrid.isActive, isClearing: sidewaysGrid.isClearingForKillSwitch, anchorPrice: sidewaysGrid.anchorPrice?.toFixed(4), upperLimit: sidewaysGrid.gridUpperLimit?.toFixed(4), lowerLimit: sidewaysGrid.gridLowerLimit?.toFixed(4), stats: sidewaysGrid.sidewaysStats, activePositions: gridPosData }
        }
    });
});
app.post('/api/configure', (req, res) => {
    const { initialAmount, overallTakeProfit, overallStopLoss } = req.body;
    let changed = false; let msg = 'Không có thay đổi.';

    if (initialAmount && parseFloat(initialAmount) > 0 && parseFloat(initialAmount) !== INITIAL_INVESTMENT_AMOUNT) {
        INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount);
        changed = true; msg = 'Vốn đã cập nhật.';
    }

    const newOverallTP = parseFloat(overallTakeProfit);
    if (!isNaN(newOverallTP) && newOverallTP !== targetOverallTakeProfit) {
        targetOverallTakeProfit = newOverallTP;
        changed = true; msg = (msg === 'Không có thay đổi.' ? '' : msg + ' ') + 'Chốt lời tổng cập nhật.';
    }
    const newOverallSL = parseFloat(overallStopLoss);
    if (!isNaN(newOverallSL) && newOverallSL !== targetOverallStopLoss) {
        targetOverallStopLoss = newOverallSL;
        changed = true; msg = (msg === 'Không có thay đổi.' ? '' : msg + ' ') + 'Cắt lỗ tổng cập nhật.';
    }

    if (changed) {
        addLog(msg);
        if (botRunning) { addLog("Bot đang chạy, một số thay đổi cấu hình cần khởi động lại bot để áp dụng hoàn toàn (ví dụ: vốn)."); }
    }
    res.json({ success: changed, message: msg });
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', async (req, res) => res.send(await stopBotLogicInternal()));

const fallbackHtmlContent = `
<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Bot Control</title></head>
<body><h1>Bot Control Panel</h1><p>File index.html không tìm thấy. Đây là giao diện cơ bản.</p>
<button onclick="fetch('/start_bot_logic').then(r=>r.text()).then(t=>alert(t))">Start Bot</button>
<button onclick="fetch('/stop_bot_logic').then(r=>r.text()).then(t=>alert(t))">Stop Bot</button>
<div id="status"></div><script>setInterval(()=>fetch('/api/status').then(r=>r.text()).then(t=>document.getElementById('status').innerText=t),3000);</script></body></html>`;

(async () => {
    try {
        await syncServerTime();
        await getExchangeInfo();
        app.listen(WEB_SERVER_PORT, '0.0.0.0', () => {
            addLog(`Web server của Bot Client đang chạy tại http://<YOUR_VPS_IP>:${WEB_SERVER_PORT}`);
            addLog(`Log file: ${CUSTOM_LOG_FILE}`);
        });
    } catch (e) {
        addLog(`LỖI NGHIÊM TRỌNG KHI KHỞI TẠO SERVER: ${e.message}. Bot có thể không hoạt động đúng.`);
         app.listen(WEB_SERVER_PORT, '0.0.0.0', () => {
            addLog(`Web server của Bot Client (CHẾ ĐỘ LỖI) đang chạy tại http://<YOUR_VPS_IP>:${WEB_SERVER_PORT}`);
        });
    }
})();
