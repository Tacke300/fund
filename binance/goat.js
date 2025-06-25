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

const WEB_SERVER_PORT = 1277;
const THIS_BOT_PM2_NAME = 'goat';
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;

const MAX_CONSECUTIVE_API_ERRORS = 3;
const ERROR_RETRY_DELAY_MS = 10000;
const LOG_COOLDOWN_MS = 2000;

const SIDEWAYS_INITIAL_TRIGGER_PERCENT = 0.005;
const SIDEWAYS_ORDER_SIZE_RATIO = 0.10;
const SIDEWAYS_GRID_RANGE_PERCENT = 0.05;
const SIDEWAYS_GRID_STEP_PERCENT = 0.005;
const SIDEWAYS_TP_PERCENT_FROM_ENTRY = 0.01;
const SIDEWAYS_SL_PERCENT_FROM_ENTRY = 0.05;

const OVERALL_VOLATILITY_THRESHOLD = 5; // Dùng chung cho cả 2 mode để quyết định/chuyển
const VOLATILITY_CHECK_INTERVAL_MS = 1 * 60 * 1000; // 1 phút
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
let TARGET_COIN_SYMBOL = 'HOMEUSDT';
let targetOverallTakeProfit = 0; // 0 nghĩa là không đặt
let targetOverallStopLoss = 0;  // 0 nghĩa là không đặt (sẽ là số âm nếu có giá trị)

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
    isActive: false,
    anchorPrice: null,
    gridUpperLimit: null,
    gridLowerLimit: null,
    lastGridMoveTime: null,
    activeGridPositions: [],
    sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 },
    lastVolatilityCheckTime: 0,
    isClearingForKillSwitch: false,
    killSwitchDelayTimeout: null
};

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
async function makeHttpRequest(method, hostname, path, headers, postData = '') { return new Promise((resolve, reject) => { const options = { hostname, path, method, headers }; const req = https.request(options, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data); } else { const errorMsg = `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`; let errorDetails = { code: res.statusCode, msg: errorMsg }; try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; } catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; } addLog(`HTTP Request lỗi: ${errorDetails.msg}`); reject(errorDetails); } }); }); req.on('error', (e) => { addLog(`Lỗi Mạng: ${e.message}`); reject({ code: 'NETWORK_ERROR', msg: e.message }); }); if (postData) req.write(postData); req.end(); }); }

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) { if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Lỗi: Thiếu API/SECRET key."); const timestamp = Date.now() + serverTimeOffset; const recvWindow = 5000; let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&'); queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`; const signature = createSignature(queryString, SECRET_KEY); let requestPath; let requestBody = ''; const headers = { 'X-MBX-APIKEY': API_KEY }; if (method === 'GET' || method === 'DELETE') { requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`; } else if (method === 'POST' || method === 'PUT') { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; } else { throw new Error(`Phương thức không hỗ trợ: ${method}`); } try { const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody); consecutiveApiErrors = 0; return JSON.parse(rawData); } catch (error) { consecutiveApiErrors++; addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`); if (error.code === -1003) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); } if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) { addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`); throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng."); } throw error; } }
async function callPublicAPI(fullEndpointPath, params = {}) { const queryString = new URLSearchParams(params).toString(); const fullPathWithQuery = `${fullEndpointPath}?${queryString}`; try { const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, {}); consecutiveApiErrors = 0; return JSON.parse(rawData); } catch (error) { consecutiveApiErrors++; addLog(`Lỗi API công khai: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`); if (error.code === -1003) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); } if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) { addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`); throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng."); } throw error; } }

async function calculateVolatilityLastHour(symbol) {
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
        addLog(`Lỗi tính biến động 1 giờ qua: ${e.message}`);
        if (e instanceof CriticalApiError) throw e; return lastCalculatedVolatility;
    }
}

async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const b = r.find(i => i.symbol === symbol)?.brackets[0]; return b ? parseInt(b.initialLeverage) : null; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const pF = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const lF = s.filters.find(f => f.filterType === 'LOT_SIZE'); const mF = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(pF?.tickSize || 0.001), stepSize: parseFloat(lF?.stepSize || 0.001), minNotional: parseFloat(mF?.notional || 0) }; }); return exchangeInfoCache; } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function getSymbolDetails(symbol) { const info = await getExchangeInfo(); return info?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); return null; } }

async function cancelAllOpenOrdersForSymbol(symbol) {
    addLog(`Hủy TẤT CẢ lệnh chờ cho ${symbol}...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) { return; }
        for (const order of openOrders) {
            try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId }); await sleep(50); }
            catch (innerErr) { if (innerErr.code !== -2011) addLog(`Lỗi hủy lệnh ${order.orderId}: ${innerErr.msg}`); if (innerErr instanceof CriticalApiError) stopBotLogicInternal(); }
        }
    } catch (error) { if (error.code !== -2011) addLog(`Lỗi lấy lệnh chờ hủy: ${error.msg}`); if (error instanceof CriticalApiError) stopBotLogicInternal(); }
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
    } catch (err) { addLog(`Lỗi đóng vị thế KILL ${positionSide}: ${err.msg}`); if (err instanceof CriticalApiError) stopBotLogicInternal(); isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    addLog(`[KILL] Mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const details = await getSymbolDetails(symbol); if (!details) throw new Error("Lỗi lấy chi tiết symbol.");
        if (!await setLeverage(symbol, maxLeverage)) throw new Error("Lỗi đặt đòn bẩy."); await sleep(200);
        const priceCalc = entryPriceOverride || await getCurrentPrice(symbol); if (!priceCalc) throw new Error("Lỗi lấy giá.");
        let qty = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceCalc;
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qty * priceCalc < details.minNotional) throw new Error("Giá trị lệnh quá nhỏ.");
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const orderRes = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
        const actualEntry = parseFloat(orderRes.avgPrice); const actualQty = parseFloat(orderRes.executedQty);
        if (actualQty === 0) throw new Error("Lệnh MARKET không khớp KL.");
        addLog(`[KILL] Đã MỞ ${tradeDirection} | KL: ${actualQty.toFixed(details.quantityPrecision)} | Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);
        return { symbol, quantity: actualQty, initialQuantity: actualQty, entryPrice: actualEntry, initialMargin: INITIAL_INVESTMENT_AMOUNT, side: tradeDirection, maxLeverageUsed: maxLeverage, pricePrecision: details.pricePrecision, quantityPrecision: details.quantityPrecision, closedLossAmount: 0, nextPartialCloseLossIndex: 0, pnlBaseForNextMoc: 0, hasAdjustedSLToSpecificLevel: {}, hasClosedAllLossPositionAtLastLevel: false, pairEntryPrice: priceCalc, currentTPId: null, currentSLId: null };
    } catch (err) { addLog(`[KILL] Lỗi mở ${tradeDirection}: ${err.msg}`); if (err instanceof CriticalApiError) stopBotLogicInternal(); return null; }
}

async function setTPAndSLForPosition(position, isFullResetEvent = false) {
    if (!position || position.quantity <= 0) return false;
    const details = await getSymbolDetails(position.symbol); if(!details) { addLog("[KILL] Không có details để đặt TP/SL"); return false;}
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity, pnlBaseForNextMoc = 0 } = position;
    addLog(`[KILL] Đặt/Reset TP/SL ${side} (Entry: ${entryPrice.toFixed(pricePrecision)}, KL: ${quantity.toFixed(position.quantityPrecision)}, PNL Base: ${pnlBaseForNextMoc.toFixed(2)}%)...`);
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
    } catch (err) { addLog(`[KILL] Lỗi đặt TP/SL ${side}: ${err.msg}.`); if (err instanceof CriticalApiError) stopBotLogicInternal(); return false; }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade || quantityToClose <=0) return false;
    isProcessingTrade = true;
    try {
        const details = await getSymbolDetails(position.symbol); if (!details) throw new Error("Lỗi lấy chi tiết symbol.");
        let qtyEff = Math.min(quantityToClose, position.quantity);
        qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qtyEff <= 0) { isProcessingTrade = false; return false; }
        const side = (position.side === 'LONG') ? 'SELL' : 'BUY';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side, positionSide: position.side, type: 'MARKET', quantity: qtyEff, newClientOrderId: `KILL-PARTIAL-${position.side}-${Date.now()}`});
        position.closedLossAmount += qtyEff; position.quantity -= qtyEff;
        if (position.quantity < details.stepSize) position.quantity = 0;
        addLog(`[KILL] Đóng ${qtyEff.toFixed(details.quantityPrecision)} ${position.side}. Còn: ${position.quantity.toFixed(details.quantityPrecision)}`);
        if (position.quantity > 0) {
            if(position.currentTPId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentTPId});} catch(e){}
            if(position.currentSLId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentSLId});} catch(e){}
            await sleep(300); await setTPAndSLForPosition(position, false);
        } else { if (position.side === 'LONG') currentLongPosition = null; else currentShortPosition = null; }
        isProcessingTrade = false; return true;
    } catch (err) { addLog(`[KILL] Lỗi đóng từng phần ${position.side}: ${err.msg}`); if (err instanceof CriticalApiError) stopBotLogicInternal(); isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!positionToModify || quantityToAdd <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;
    try {
        const details = await getSymbolDetails(positionToModify.symbol); if (!details) throw new Error("Lỗi lấy chi tiết symbol.");
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
        if (!tpslOk) addLog("[KILL] Lỗi đặt lại TP/SL sau khi thêm vị thế.");
        isProcessingTrade = false; return true;
    } catch (err) { addLog(`[KILL] Lỗi mở lại lệnh ${positionToModify.side}: ${err.msg}`); if (err instanceof CriticalApiError) stopBotLogicInternal(); isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function openGridPositionAndSetTPSL(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    addLog(`[LƯỚI] Mở lệnh ${tradeDirection} bước ${stepIndex}, giá mục tiêu ~${entryPriceToTarget.toFixed(4)}`);
    try {
        const details = await getSymbolDetails(symbol); if (!details) throw new Error("Lỗi lấy chi tiết symbol cho lệnh lưới.");
        const maxLev = await getLeverageBracketForSymbol(symbol); if (!maxLev) throw new Error("Không lấy được đòn bẩy cho lệnh lưới.");
        if (!await setLeverage(symbol, maxLev)) throw new Error("Lỗi đặt đòn bẩy."); await sleep(200);
        let qty = (INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO * maxLev) / entryPriceToTarget;
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qty * entryPriceToTarget < details.minNotional) throw new Error(`Giá trị lệnh lưới quá nhỏ.`);
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const marketOrderRes = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
        const actualEntry = parseFloat(marketOrderRes.avgPrice); const actualQty = parseFloat(marketOrderRes.executedQty);
        if (actualQty === 0) throw new Error("Lệnh lưới MARKET không khớp KL.");
        addLog(`[LƯỚI] Đã MỞ ${tradeDirection} KL: ${actualQty.toFixed(details.quantityPrecision)}, Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);
        const gridPos = { id: marketOrderRes.orderId, symbol, side: tradeDirection, entryPrice: actualEntry, quantity: actualQty, tpOrderId: null, slOrderId: null, originalAnchorPrice: sidewaysGrid.anchorPrice, stepIndex };
        let tpVal = actualEntry * (1 + (tradeDirection === 'LONG' ? SIDEWAYS_TP_PERCENT_FROM_ENTRY : -SIDEWAYS_TP_PERCENT_FROM_ENTRY));
        let slVal = actualEntry * (1 - (tradeDirection === 'LONG' ? SIDEWAYS_SL_PERCENT_FROM_ENTRY : -SIDEWAYS_SL_PERCENT_FROM_ENTRY));
        tpVal = parseFloat(tpVal.toFixed(details.pricePrecision)); slVal = parseFloat(slVal.toFixed(details.pricePrecision));
        const tpslSide = (tradeDirection === 'LONG') ? 'SELL' : 'BUY';
        try { const tpOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: tpslSide, positionSide: tradeDirection, type: 'TAKE_PROFIT_MARKET', stopPrice: tpVal, quantity: actualQty, timeInForce: 'GTC', closePosition: true, newClientOrderId: `GRID-TP-${tradeDirection[0]}${stepIndex}-${Date.now()}` }); gridPos.tpOrderId = tpOrd.orderId; } catch (e) { addLog(`[LƯỚI] LỖI đặt TP ${tradeDirection} ${actualEntry.toFixed(4)}: ${e.msg}`); }
        try { const slOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: tpslSide, positionSide: tradeDirection, type: 'STOP_MARKET', stopPrice: slVal, quantity: actualQty, timeInForce: 'GTC', closePosition: true, newClientOrderId: `GRID-SL-${tradeDirection[0]}${stepIndex}-${Date.now()}` }); gridPos.slOrderId = slOrd.orderId; } catch (e) { addLog(`[LƯỚI] LỖI đặt SL ${tradeDirection} ${actualEntry.toFixed(4)}: ${e.msg}`); }
        sidewaysGrid.activeGridPositions.push(gridPos); return gridPos;
    } catch (err) { addLog(`[LƯỚI] LỖI MỞ LỆNH ${tradeDirection}: ${err.msg || err.message}`); if (err instanceof CriticalApiError) stopBotLogicInternal(); return null; }
}

async function closeSpecificGridPosition(gridPosObj, reasonForClose, isSlEvent = false, isTpEvent = false) {
    if (!gridPosObj) return;
    addLog(`[LƯỚI] Đóng lệnh ${gridPosObj.side} ${gridPosObj.id} @${gridPosObj.entryPrice.toFixed(4)}. Lý do: ${reasonForClose}`);
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
        } catch (err) { addLog(`[LƯỚI] Lỗi MARKET đóng ${gridPosObj.side} ${gridPosObj.id}: ${err.msg}`); }
    }
    sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== gridPosObj.id);
    if (isSlEvent) sidewaysGrid.sidewaysStats.slMatchedCount++; if (isTpEvent) sidewaysGrid.sidewaysStats.tpMatchedCount++;
}

async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || isProcessingTrade || sidewaysGrid.isClearingForKillSwitch) return;
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
    if (Date.now() - sidewaysGrid.lastVolatilityCheckTime > VOLATILITY_CHECK_INTERVAL_MS) { // VOLATILITY_CHECK_INTERVAL_MS là 1 phút
        sidewaysGrid.lastVolatilityCheckTime = Date.now();
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
        if (lastCalculatedVolatility >= OVERALL_VOLATILITY_THRESHOLD) { // OVERALL_VOLATILITY_THRESHOLD
            addLog(`[LƯỚI] Đang chuyển sang chế độ KILL do biến động mạnh (${lastCalculatedVolatility.toFixed(2)}%).`);
            if (!sidewaysGrid.isClearingForKillSwitch) {
                sidewaysGrid.isClearingForKillSwitch = true;
                await closeAllSidewaysPositionsAndOrders("Chuyển sang KILL do biến động mạnh");
                if(sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout);
                sidewaysGrid.killSwitchDelayTimeout = setTimeout(async () => {
                    addLog(`[LƯỚI] Hết 70s chờ. Kích hoạt KILL mode.`);
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
    addLog(`[LƯỚI] Đóng tất cả vị thế Sideways. Lý do: ${reason}`);
    const activeCopy = [...sidewaysGrid.activeGridPositions];
    for (const pos of activeCopy) {
        if (pos.tpOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.tpOrderId }); } catch (e) {} }
        if (pos.slOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.slOrderId }); } catch (e) {} }
    }
    await sleep(500);
    for (const pos of activeCopy) { await closeSpecificGridPosition(pos, `Đóng toàn bộ: ${reason}`); await sleep(300); }
    sidewaysGrid.isActive = false; sidewaysGrid.anchorPrice = null;
}

async function checkOverallTPSL() {
    if (!botRunning) return false;
    let stopReason = null;
    if (targetOverallTakeProfit > 0 && netPNL >= targetOverallTakeProfit) {
        stopReason = `Chốt lời toàn bộ bot đạt ${targetOverallTakeProfit} USDT (PNL Ròng: ${netPNL.toFixed(2)} USDT).`;
    } else if (targetOverallStopLoss < 0 && netPNL <= targetOverallStopLoss) { // targetOverallStopLoss là số âm
        stopReason = `Cắt lỗ toàn bộ bot đạt ${targetOverallStopLoss} USDT (PNL Ròng: ${netPNL.toFixed(2)} USDT).`;
    }

    if (stopReason) {
        addLog(stopReason + " Đang dừng bot...");
        stopBotLogicInternal(); // Hàm này đã có sẵn và xử lý dừng bot
        // Có thể thêm logic gửi thông báo ở đây nếu muốn
        return true; // Bot đã dừng
    }
    return false; // Bot tiếp tục chạy
}

async function runTradingLogic() {
    if (!botRunning || sidewaysGrid.isClearingForKillSwitch) return;
    if (await checkOverallTPSL()) return; // Kiểm tra TP/SL tổng ở đầu mỗi chu kỳ

    await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
    const prevMode = currentBotMode;

    if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD && !sidewaysGrid.isActive && !currentLongPosition && !currentShortPosition) {
        currentBotMode = 'sideways';
    } else if (lastCalculatedVolatility > OVERALL_VOLATILITY_THRESHOLD && currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        // Để manageSidewaysGridLogic xử lý, nó sẽ log "Đang chuyển..."
    } else if (lastCalculatedVolatility > OVERALL_VOLATILITY_THRESHOLD && currentBotMode !== 'kill') {
        if (sidewaysGrid.isActive) { /* manageSidewaysGridLogic xử lý */ } else { currentBotMode = 'kill'; }
    }
    
    if (prevMode !== currentBotMode && !sidewaysGrid.isClearingForKillSwitch) {
        addLog(`Chế độ thay đổi từ ${prevMode.toUpperCase()} sang ${currentBotMode.toUpperCase()} (Vol 1h qua: ${lastCalculatedVolatility.toFixed(2)}%)`);
    }

    if (currentBotMode === 'sideways') {
        if (!sidewaysGrid.isActive) {
            if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isClearingForKillSwitch) {
                addLog('[LƯỚI] Kích hoạt chế độ Sideways.');
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
                             catch (e) { if(e instanceof CriticalApiError) stopBotLogicInternal(); }
                         } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                             clearInterval(positionCheckInterval); positionCheckInterval = null;
                         }
                     }, VOLATILITY_CHECK_INTERVAL_MS); // Kiểm tra mỗi phút (cũng là tần suất check vol)
                }
            } else { if(botRunning) scheduleNextMainCycle(); }
        }
        return;
    }

    if (currentLongPosition || currentShortPosition || sidewaysGrid.isActive) return;
    
    addLog('Bắt đầu chu kỳ giao dịch KILL mới...');
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
                     catch (e) { if(e instanceof CriticalApiError) stopBotLogicInternal(); }
                 } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                     clearInterval(positionCheckInterval); positionCheckInterval = null;
                 }
             }, VOLATILITY_CHECK_INTERVAL_MS); // Kiểm tra mỗi phút
        }
    } catch (err) { if(err instanceof CriticalApiError) stopBotLogicInternal(); if(botRunning) scheduleNextMainCycle(); }
}

const manageOpenPosition = async () => {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForKillSwitch) return;
    if (await checkOverallTPSL()) return; // Kiểm tra TP/SL tổng

    // Logic kiểm tra biến động và chuyển mode cho Kill mode
    if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) { // Chỉ kiểm tra nếu đang có lệnh Kill
        if (Date.now() - (sidewaysGrid.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS) { // Dùng lại biến thời gian của sideways để tránh check quá nhiều
            sidewaysGrid.lastVolatilityCheckTime = Date.now();
            await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
            if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD) {
                addLog(`[KILL] Biến động giảm (${lastCalculatedVolatility.toFixed(2)}%), đang chuyển sang chế độ SIDEWAYS.`);
                // Không dùng isClearingForKillSwitch ở đây vì đây là chuyển từ Kill -> Sideways
                currentBotMode = 'sideways';
                if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, "Chuyển sang Sideways từ Kill (vol giảm)", "LONG");
                if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, "Chuyển sang Sideways từ Kill (vol giảm)", "SHORT");
                currentLongPosition = null; currentShortPosition = null;
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                sidewaysGrid.isActive = false; // Để runTradingLogic kích hoạt lại Sideways
                scheduleNextMainCycle();
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
                                // Không check vol ở đây nữa vì đã check ở đầu manageOpenPosition
                                // const vol = await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
                                // if (vol > OVERALL_VOLATILITY_THRESHOLD) { 
                                    addLog(`[KILL REOPEN] ${posChk.side} về Mốc 5. Mở lại ${otherP.side}.`);
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
                                // }
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
                if (MOC5_REL_PNL === undefined || MOC8_REL_PNL === undefined) { addLog("Lỗi: partialCloseLossLevels không đúng."); return; }
                let actionTaken = false;
                if (pnlPctWin >= absThreshMoc) {
                    actionTaken = true; const mocIdxReached = winningPos.nextPartialCloseLossIndex;
                    // Không check vol ở đây nữa vì đã check ở đầu manageOpenPosition
                    // const currentVolCheck = await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
                    // if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD && mocIdxReached >= MOC5_IDX) { /* ... chuyển mode ... */ }
                    // else { /* ... xử lý kill ... */ }
                    let qtyFrac = (mocIdxReached === MOC5_IDX) ? 0.20 : (mocIdxReached >= MOC8_IDX) ? 1.00 : 0.10;
                    if(await closePartialPosition(losingPos, qtyFrac === 1.00 ? losingPos.quantity : losingPos.initialQuantity * qtyFrac)) { winningPos.nextPartialCloseLossIndex++; }
                    if (mocIdxReached === MOC5_IDX && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL]) {
                        const lossPctSL = MOC8_REL_PNL / 100; const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100; const targetPnlSLLUSD = -(losingPos.initialMargin * lossPctSL) + pnlBaseLosingUSD; const priceChangeSL = Math.abs(targetPnlSLLUSD) / losingPos.initialQuantity; const slPrice = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeSL : losingPos.entryPrice + priceChangeSL).toFixed(losingPos.pricePrecision));
                        if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); } catch(e){} }
                        const newSL = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: losingPos.symbol, side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: losingPos.side, type: 'STOP_MARKET', stopPrice: slPrice, quantity: losingPos.quantity, timeInForce: 'GTC', closePosition: true });
                        if (newSL.orderId) { losingPos.currentSLId = newSL.orderId; winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL] = true; addLog(`SL lệnh lỗ ${losingPos.side} rời về ${slPrice.toFixed(losingPos.pricePrecision)}`); }
                    }
                    if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > MOC8_IDX && actionTaken) ) { losingPos.hasClosedAllLossPositionAtLastLevel = true; }
                }
                const absPnlThreshMoc8 = (winningPos.pnlBaseForNextMoc || 0) + MOC8_REL_PNL;
                if (pnlPctWin >= absPnlThreshMoc8 && !losingPos.hasClosedAllLossPositionAtLastLevel && losingPos.quantity > 0 && !actionTaken) {
                     await closePosition(losingPos.symbol, `Đóng nốt ở Mốc 8 lãi lệnh thắng (Kill)`, losingPos.side);
                     if (losingPos) { losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; }
                }
            }
            if (losingPos?.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos?.quantity > 0) {
                const pairEntry = winningPos.pairEntryPrice; const tol = (pairEntry || currentMarketPrice || 0) * 0.0005;
                if (currentMarketPrice && pairEntry && Math.abs(currentMarketPrice - pairEntry) <= tol) {
                    if (!isProcessingTrade) { await addPosition(losingPos, losingPos.closedLossAmount, "price_near_pair_entry_reopen"); }
                }
            }
        } catch (err) { addLog("Lỗi manageOpenPosition (Kill): " + (err.msg || err.message)); if(err instanceof CriticalApiError) stopBotLogicInternal(); }
    }
};

async function processTradeResult(orderInfo) {
    if(isProcessingTrade && orderInfo.X !== 'FILLED') return;
    const wasProc = isProcessingTrade; isProcessingTrade = true;
    const { s: sym, rp: rPnlStr, X: ordStatus, i: ordId, ps: posSide, z: filledQtyStr, S: sideOrd, ap: avgPxStr } = orderInfo;
    const filledQty = parseFloat(filledQtyStr); const rPnl = parseFloat(rPnlStr); const avgPx = parseFloat(avgPxStr);
    if (sym !== TARGET_COIN_SYMBOL || ordStatus !== 'FILLED' || filledQty === 0) { if(!wasProc) isProcessingTrade = false; return; }
    addLog(`[Trade FILLED] ID ${ordId} (${posSide} ${sideOrd}) KL ${filledQty.toFixed(4)} @ ${avgPx.toFixed(4)} | PNL Thực Tế: ${rPnl.toFixed(4)}`);
    if (rPnl !== 0) { if (rPnl > 0) totalProfit += rPnl; else totalLoss += Math.abs(rPnl); netPNL = totalProfit - totalLoss; addLog(`PNL Ròng: ${netPNL.toFixed(2)} (Lời: ${totalProfit.toFixed(2)}, Lỗ: ${totalLoss.toFixed(2)})`); }
    if (await checkOverallTPSL()) { if(!wasProc) isProcessingTrade = false; return; } // Kiểm tra TP/SL tổng sau khi PNL cập nhật

    if (sidewaysGrid.isActive) {
        const matchedGrid = sidewaysGrid.activeGridPositions.find(p => p.tpOrderId === ordId || p.slOrderId === ordId);
        if (matchedGrid) {
            const isTp = matchedGrid.tpOrderId === ordId, isSl = matchedGrid.slOrderId === ordId;
            if (isTp) { await closeSpecificGridPosition(matchedGrid, "TP lưới khớp", false, true); }
            else if (isSl) { await closeSpecificGridPosition(matchedGrid, "SL lưới khớp", true, false); }
            if(!wasProc) isProcessingTrade = false; return;
        }
    }
    const isLongCloseKill = currentLongPosition && (ordId == currentLongPosition.currentTPId || ordId == currentLongPosition.currentSLId);
    const isShortCloseKill = currentShortPosition && (ordId == currentShortPosition.currentTPId || ordId == currentShortPosition.currentSLId);
    if (currentBotMode === 'kill' && (isLongCloseKill || isShortCloseKill)) {
        const closedSide = posSide; const remainingPos = (closedSide === 'LONG') ? currentShortPosition : currentLongPosition;
        if (closedSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;
        if (rPnl >= 0) {
             if (remainingPos?.quantity > 0) {
                 try { const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPos.symbol }); const qtyEx = Math.abs(parseFloat(positions.find(p => p.symbol === remainingPos.symbol && p.positionSide === remainingPos.side)?.positionAmt || 0)); if (qtyEx > 0) { await closePosition(remainingPos.symbol, `Lãi KILL (${closedSide}) chốt`, remainingPos.side); } }
                 catch(e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); }
             }
             await cleanupAndResetCycle(sym);
        } else { /* Lệnh lỗ chạy tiếp */ }
    } else if (currentBotMode === 'kill') {
        await sleep(500);
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            if (currentLongPosition) { const lp = positions.find(p=>p.positionSide==='LONG'); currentLongPosition.quantity=lp?Math.abs(parseFloat(lp.positionAmt)):0; if(currentLongPosition.quantity===0)currentLongPosition=null;}
            if (currentShortPosition) { const sp = positions.find(p=>p.positionSide==='SHORT'); currentShortPosition.quantity=sp?Math.abs(parseFloat(sp.positionAmt)):0; if(currentShortPosition.quantity===0)currentShortPosition=null;}
            if(!currentLongPosition && !currentShortPosition && botRunning) { await cleanupAndResetCycle(TARGET_COIN_SYMBOL); }
        } catch (e) { addLog("Lỗi cập nhật KL sau partial close Kill: " + e.message); }
    }
    if(!wasProc) isProcessingTrade = false;
}

async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ ${symbol} kết thúc. Dọn dẹp...`);
    if (sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) { await closeAllSidewaysPositionsAndOrders("Dọn dẹp chu kỳ"); }
    else if (sidewaysGrid.isClearingForKillSwitch) { /* Đang dọn để chuyển kill */ }
    currentLongPosition = null; currentShortPosition = null;
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    await cancelAllOpenOrdersForSymbol(symbol); await checkAndHandleRemainingPosition(symbol);
    if (botRunning && !sidewaysGrid.isClearingForKillSwitch) { scheduleNextMainCycle(); }
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.'; if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.';
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime(); await getExchangeInfo();
        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
        totalProfit=0; totalLoss=0; netPNL=0; currentLongPosition = null; currentShortPosition = null;
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL); // Lấy vol ban đầu, currentBotMode sẽ set trong runTradingLogic
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey);
        setupMarketDataStream(TARGET_COIN_SYMBOL); botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        scheduleNextMainCycle(); return 'Bot khởi động thành công.';
    } catch (err) { stopBotLogicInternal(); if (err instanceof CriticalApiError && !retryBotTimeout) { retryBotTimeout = setTimeout(async () => { retryBotTimeout = null; await startBotLogicInternal(); }, ERROR_RETRY_DELAY_MS); } return `Lỗi khởi động bot: ${err.msg || err.message}`; }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.'; addLog('--- Dừng Bot ---');
    botRunning = false; clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    if (sidewaysGrid.killSwitchDelayTimeout) { clearTimeout(sidewaysGrid.killSwitchDelayTimeout); sidewaysGrid.killSwitchDelayTimeout = null; }
    sidewaysGrid.isActive = false; sidewaysGrid.activeGridPositions = []; sidewaysGrid.isClearingForKillSwitch = false;
    if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
    if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.close(); userDataWs = null; }
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
            for (const pos of remaining) { const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT'; await closePosition(pos.symbol, `Dọn dẹp vị thế sót`, sideToClose); await sleep(1000); }
        }
    } catch (error) { if (error instanceof CriticalApiError) stopBotLogicInternal(); }
}

const app = express(); app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) return res.status(500).send('Lỗi đọc log'); const clean = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.send(clean.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => exec('pm2 jlist', (e, stdout, stderr) => e ? reject(stderr || e.message) : resolve(stdout)));
        const processes = JSON.parse(pm2List); const botProc = processes.find(p => p.name === THIS_BOT_PM2_NAME);
        let statusMsg = `Bot PM2 '${THIS_BOT_PM2_NAME}' không tìm thấy.`;
        if (botProc) {
            statusMsg = `MÁY CHỦ: ${botProc.pm2_env.status.toUpperCase()} (Restarts: ${botProc.pm2_env.restart_time})`;
            if (botProc.pm2_env.status === 'online') {
                statusMsg += ` | BOT: ${botRunning ? 'CHẠY' : 'DỪNG'}`;
                if (botStartTime && botRunning) statusMsg += ` | Uptime: ${Math.floor((Date.now() - botStartTime.getTime()) / 60000)}p`;
                statusMsg += ` | ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | Mode: ${currentBotMode.toUpperCase()} (Vol 1h qua:${lastCalculatedVolatility.toFixed(1)}%)`;
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
            positions: killPosData, invest: INITIAL_INVESTMENT_AMOUNT, coin: TARGET_COIN_SYMBOL,
            targetOverallTakeProfit: targetOverallTakeProfit, // Trả về giá trị cấu hình
            targetOverallStopLoss: targetOverallStopLoss,   // Trả về giá trị cấu hình
            sidewaysGridInfo: { isActive: sidewaysGrid.isActive, isClearing: sidewaysGrid.isClearingForKillSwitch, anchorPrice: sidewaysGrid.anchorPrice?.toFixed(4), upperLimit: sidewaysGrid.gridUpperLimit?.toFixed(4), lowerLimit: sidewaysGrid.gridLowerLimit?.toFixed(4), stats: sidewaysGrid.sidewaysStats, activePositions: gridPosData }
        }
    });
});
app.post('/api/configure', (req, res) => {
    const { coinConfigs, overallTakeProfit, overallStopLoss } = req.body; // Thêm overallTakeProfit, overallStopLoss
    let changed = false; let msg = 'Không có thay đổi.';

    if (coinConfigs && coinConfigs.length > 0) {
        const cfg = coinConfigs[0]; let coinCfgChanged = false;
        if (cfg.symbol && cfg.symbol.trim().toUpperCase() !== TARGET_COIN_SYMBOL) { TARGET_COIN_SYMBOL = cfg.symbol.trim().toUpperCase(); coinCfgChanged = true; }
        if (cfg.initialAmount && parseFloat(cfg.initialAmount) > 0 && parseFloat(cfg.initialAmount) !== INITIAL_INVESTMENT_AMOUNT) { INITIAL_INVESTMENT_AMOUNT = parseFloat(cfg.initialAmount); coinCfgChanged = true; }
        if (coinCfgChanged) { changed = true; msg = 'Cấu hình coin/vốn đã cập nhật.'; }
    }

    const newOverallTP = parseFloat(overallTakeProfit);
    if (!isNaN(newOverallTP) && newOverallTP !== targetOverallTakeProfit) {
        targetOverallTakeProfit = newOverallTP;
        changed = true;
        msg = (msg === 'Không có thay đổi.' ? 'Chốt lời tổng cập nhật.' : msg + ' Chốt lời tổng cập nhật.');
    }
    const newOverallSL = parseFloat(overallStopLoss);
    if (!isNaN(newOverallSL) && newOverallSL !== targetOverallStopLoss) { // SL là số âm hoặc 0
        targetOverallStopLoss = newOverallSL;
        changed = true;
        msg = (msg === 'Không có thay đổi.' ? 'Cắt lỗ tổng cập nhật.' : msg + ' Cắt lỗ tổng cập nhật.');
    }

    if (changed) {
        addLog(msg);
        // Reset PNL và trạng thái lưới nếu coin/vốn thay đổi HOẶC TP/SL tổng thay đổi để bắt đầu lại việc tính toán
        totalProfit = 0; totalLoss = 0; netPNL = 0;
        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
        if (botRunning) { addLog("Bot đang chạy, sẽ dừng. Vui lòng khởi động lại."); const stopMsgTxt = stopBotLogicInternal(); msg += ` ${stopMsgTxt} Vui lòng khởi động lại bot.`; }
    }
    res.json({ success: changed, message: msg });
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT, () => addLog(`Web server: http://localhost:${WEB_SERVER_PORT}`));
