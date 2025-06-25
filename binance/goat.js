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

const SIDEWAYS_VOLATILITY_THRESHOLD = 5;
const SIDEWAYS_VOLATILITY_CHECK_INTERVAL_MS = 1 * 60 * 1000; // 1 phút
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
let lastCalculatedVolatility = 0; // Thay cho lastHourVolatility, sẽ cập nhật thường xuyên

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

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });
    return formatter.format(dateObject);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data); }
                else {
                    const errorMsg = `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; }
                    catch (e) { errorDetails.msg += ` - Raw: ${data.substring(0, 200)}`; }
                    addLog(`HTTP Request lỗi: ${errorDetails.msg}`); reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => { addLog(`Lỗi Mạng: ${e.message}`); reject({ code: 'NETWORK_ERROR', msg: e.message }); });
        if (postData) req.write(postData); req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Lỗi: Thiếu API/SECRET key.");
    const timestamp = Date.now() + serverTimeOffset;
    const recvWindow = 5000;
    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY);
    let requestPath, requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };
    if (method === 'GET' || method === 'DELETE') { requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`; }
    else if (method === 'POST' || method === 'PUT') { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else { throw new Error(`Phương thức không hỗ trợ: ${method}`); }
    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0; return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++; addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); }
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
        consecutiveApiErrors = 0; return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++; addLog(`Lỗi API công khai: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Quá nhiều lỗi API liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function calculateVolatilityLastHour(symbol) { // YÊU CẦU MỚI: Tính biến động 1 giờ qua
    try {
        // Lấy 60 cây nến 1 phút gần nhất
        const klines = await callPublicAPI('/fapi/v1/klines', { symbol: symbol, interval: '1m', limit: 60 });
        if (klines && klines.length === 60) {
            let minLow = parseFloat(klines[0][3]); // Low của cây nến đầu tiên
            let maxHigh = parseFloat(klines[0][2]); // High của cây nến đầu tiên

            for (let i = 1; i < klines.length; i++) {
                const low = parseFloat(klines[i][3]);
                const high = parseFloat(klines[i][2]);
                if (low < minLow) minLow = low;
                if (high > maxHigh) maxHigh = high;
            }

            if (minLow > 0) {
                const volatility = ((maxHigh - minLow) / minLow) * 100;
                lastCalculatedVolatility = volatility; // Cập nhật biến toàn cục
                return volatility;
            }
        }
        addLog(`Không đủ dữ liệu nến 1 phút (cần 60, có ${klines?.length}) để tính biến động 1 giờ.`);
        return lastCalculatedVolatility; // Trả về giá trị cũ nếu không tính được
    } catch (e) {
        addLog(`Lỗi khi lấy/tính toán biến động 1 giờ qua (1m klines): ${e.message}`);
        if (e instanceof CriticalApiError) throw e;
        return lastCalculatedVolatility; // Trả về giá trị cũ
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
        if (!openOrders || openOrders.length === 0) { addLog(`Không có lệnh chờ nào cho ${symbol}.`); return; }
        for (const order of openOrders) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId });
                addLog(`Đã hủy lệnh ${order.orderId}`); await sleep(100);
            } catch (innerErr) {
                if (innerErr.code !== -2011) addLog(`Lỗi hủy lệnh ${order.orderId}: ${innerErr.msg || innerErr.message}`);
                if (innerErr instanceof CriticalApiError) stopBotLogicInternal();
            }
        }
    } catch (error) {
        if (error.code !== -2011) addLog(`Lỗi lấy lệnh chờ để hủy tất cả: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

async function closePosition(symbol, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSide || isProcessingTrade) return false;
    isProcessingTrade = true;
    addLog(`Đóng lệnh KILL ${positionSide} ${symbol} (Lý do: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);
        if (posOnEx) {
            const qty = Math.abs(parseFloat(posOnEx.positionAmt));
            if (qty === 0) { isProcessingTrade = false; return false; }
            const side = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side, positionSide, type: 'MARKET', quantity: qty });
            addLog(`Đã gửi lệnh MARKET đóng ${qty} ${positionSide} của KILL mode.`);
            if (positionSide === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
            else if (positionSide === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;
            isProcessingTrade = false; return true;
        } else {
            addLog(`Không tìm thấy vị thế KILL ${positionSide} trên sàn để đóng.`);
            isProcessingTrade = false; return false;
        }
    } catch (err) {
        addLog(`Lỗi đóng vị thế KILL ${positionSide}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError) stopBotLogicInternal();
        isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(err instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function openGridPositionAndSetTPSL(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    addLog(`[LƯỚI] Chuẩn bị mở lệnh ${tradeDirection} tại bước ${stepIndex}, giá mục tiêu ~${entryPriceToTarget.toFixed(4)}`);
    try {
        const details = await getSymbolDetails(symbol);
        if (!details) throw new Error("Lỗi lấy chi tiết symbol cho lệnh lưới.");
        const maxLev = await getLeverageBracketForSymbol(symbol);
        if (!maxLev) throw new Error("Không lấy được đòn bẩy cho lệnh lưới.");
        if (!await setLeverage(symbol, maxLev)) throw new Error("Lỗi đặt đòn bẩy cho lệnh lưới.");
        await sleep(200);
        let qty = (INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO * maxLev) / entryPriceToTarget;
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qty * entryPriceToTarget < details.minNotional) {
            throw new Error(`Giá trị lệnh lưới quá nhỏ: ${qty * entryPriceToTarget} USDT < ${details.minNotional} USDT.`);
        }
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const marketOrderRes = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT'
        });
        const actualEntry = parseFloat(marketOrderRes.avgPrice);
        const actualQty = parseFloat(marketOrderRes.executedQty);
        if (actualQty === 0) throw new Error("Lệnh lưới MARKET không khớp được KL nào.");
        addLog(`[LƯỚI] Đã MỞ ${tradeDirection} KL: ${actualQty.toFixed(details.quantityPrecision)}, Giá vào thực tế: ${actualEntry.toFixed(details.pricePrecision)}`);
        const gridPos = {
            id: marketOrderRes.orderId, symbol, side: tradeDirection, entryPrice: actualEntry, quantity: actualQty,
            tpOrderId: null, slOrderId: null, originalAnchorPrice: sidewaysGrid.anchorPrice, stepIndex: stepIndex
        };
        let tpVal = actualEntry * (1 + (tradeDirection === 'LONG' ? SIDEWAYS_TP_PERCENT_FROM_ENTRY : -SIDEWAYS_TP_PERCENT_FROM_ENTRY));
        let slVal = actualEntry * (1 - (tradeDirection === 'LONG' ? SIDEWAYS_SL_PERCENT_FROM_ENTRY : -SIDEWAYS_SL_PERCENT_FROM_ENTRY));
        tpVal = parseFloat(tpVal.toFixed(details.pricePrecision));
        slVal = parseFloat(slVal.toFixed(details.pricePrecision));
        const tpslSide = (tradeDirection === 'LONG') ? 'SELL' : 'BUY';
        try {
            const tpOrd = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: tpslSide, positionSide: tradeDirection, type: 'TAKE_PROFIT_MARKET',
                stopPrice: tpVal, quantity: actualQty, timeInForce: 'GTC', closePosition: true,
                newClientOrderId: `GRID-TP-${tradeDirection[0]}${stepIndex}-${Date.now()}`
            });
            gridPos.tpOrderId = tpOrd.orderId;
            addLog(`[LƯỚI] Đặt TP cho ${tradeDirection} ${actualEntry.toFixed(4)} tại ${tpVal.toFixed(4)} (ID: ${tpOrd.orderId})`);
        } catch (e) { addLog(`[LƯỚI] LỖI đặt TP cho ${tradeDirection} ${actualEntry.toFixed(4)}: ${e.msg || e.message}`); }
        try {
            const slOrd = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: tpslSide, positionSide: tradeDirection, type: 'STOP_MARKET',
                stopPrice: slVal, quantity: actualQty, timeInForce: 'GTC', closePosition: true,
                newClientOrderId: `GRID-SL-${tradeDirection[0]}${stepIndex}-${Date.now()}`
            });
            gridPos.slOrderId = slOrd.orderId;
            addLog(`[LƯỚI] Đặt SL cho ${tradeDirection} ${actualEntry.toFixed(4)} tại ${slVal.toFixed(4)} (ID: ${slOrd.orderId})`);
        } catch (e) { addLog(`[LƯỚI] LỖI đặt SL cho ${tradeDirection} ${actualEntry.toFixed(4)}: ${e.msg || e.message}`); }
        sidewaysGrid.activeGridPositions.push(gridPos);
        return gridPos;
    } catch (err) {
        addLog(`[LƯỚI] LỖI NGHIÊM TRỌNG khi mở lệnh lưới ${tradeDirection}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError) stopBotLogicInternal();
        return null;
    }
}

async function closeSpecificGridPosition(gridPosObj, reasonForClose, isSlEvent = false, isTpEvent = false) {
    if (!gridPosObj) return;
    addLog(`[LƯỚI] Chuẩn bị đóng lệnh lưới ${gridPosObj.side} ${gridPosObj.id} tại ${gridPosObj.entryPrice.toFixed(4)}. Lý do: ${reasonForClose}`);
    if (gridPosObj.tpOrderId) {
        try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: gridPosObj.symbol, orderId: gridPosObj.tpOrderId }); }
        catch (e) { if (e.code !== -2011) addLog(`[LƯỚI] Lỗi hủy TP ${gridPosObj.tpOrderId} khi đóng: ${e.msg}`);}
    }
    if (gridPosObj.slOrderId) {
         try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: gridPosObj.symbol, orderId: gridPosObj.slOrderId }); }
         catch (e) { if (e.code !== -2011) addLog(`[LƯỚI] Lỗi hủy SL ${gridPosObj.slOrderId} khi đóng: ${e.msg}`);}
    }
    await sleep(300);
    if (!isSlEvent && !isTpEvent) {
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: gridPosObj.symbol });
            const posOnEx = positions.find(p => p.symbol === gridPosObj.symbol && p.positionSide === gridPosObj.side && Math.abs(parseFloat(p.positionAmt)) >= gridPosObj.quantity * 0.9); // Kiểm tra KL gần bằng
            if (posOnEx) {
                const qtyToClose = Math.abs(parseFloat(posOnEx.positionAmt));
                if (qtyToClose > 0) {
                    const side = gridPosObj.side === 'LONG' ? 'SELL' : 'BUY';
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: gridPosObj.symbol, side, positionSide: gridPosObj.side, type: 'MARKET', quantity: qtyToClose
                    });
                    addLog(`[LƯỚI] Đã gửi lệnh MARKET đóng ${qtyToClose.toFixed(4)} ${gridPosObj.side} tại ${gridPosObj.entryPrice.toFixed(4)}.`);
                }
            } else { addLog(`[LƯỚI] Không tìm thấy vị thế ${gridPosObj.side} ${gridPosObj.id} trên sàn để đóng (có thể đã đóng).`); }
        } catch (err) { addLog(`[LƯỚI] Lỗi khi gửi lệnh MARKET đóng lưới cho ${gridPosObj.side} ${gridPosObj.id}: ${err.msg || err.message}`); }
    } else { addLog(`[LƯỚI] Lệnh ${gridPosObj.side} ${gridPosObj.id} được đóng bởi ${isTpEvent ? 'TP' : 'SL'} trên sàn.`); }
    sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== gridPosObj.id);
    if (isSlEvent) sidewaysGrid.sidewaysStats.slMatchedCount++;
    if (isTpEvent) sidewaysGrid.sidewaysStats.tpMatchedCount++;
    addLog(`[LƯỚI] Thống kê: TP Khớp = ${sidewaysGrid.sidewaysStats.tpMatchedCount}, SL Khớp = ${sidewaysGrid.sidewaysStats.slMatchedCount}`);
}

async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || isProcessingTrade || sidewaysGrid.isClearingForKillSwitch) return;

    const existingPosFromCurrentAnchor = sidewaysGrid.activeGridPositions.filter(p => p.originalAnchorPrice === sidewaysGrid.anchorPrice);
    if (existingPosFromCurrentAnchor.length === 0) { // Chưa có lệnh nào từ anchor hiện tại (mốc 0 của khung này)
        let side = null, targetEntry = null;
        if (currentMarketPrice >= sidewaysGrid.anchorPrice * (1 + SIDEWAYS_INITIAL_TRIGGER_PERCENT)) { side = 'SHORT'; targetEntry = sidewaysGrid.anchorPrice * (1 + SIDEWAYS_INITIAL_TRIGGER_PERCENT); }
        else if (currentMarketPrice <= sidewaysGrid.anchorPrice * (1 - SIDEWAYS_INITIAL_TRIGGER_PERCENT)) { side = 'LONG'; targetEntry = sidewaysGrid.anchorPrice * (1 - SIDEWAYS_INITIAL_TRIGGER_PERCENT); }
        if (side) {
            addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(4)}) chạm trigger ${SIDEWAYS_INITIAL_TRIGGER_PERCENT*100}% từ anchor ${sidewaysGrid.anchorPrice.toFixed(4)}. Mở ${side} (step 0).`);
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, side, targetEntry, 0);
        }
    }

    const MAX_STEPS = Math.floor(SIDEWAYS_GRID_RANGE_PERCENT / SIDEWAYS_GRID_STEP_PERCENT); // 10
    for (let i = 1; i <= MAX_STEPS; i++) {
        const shortTrig = sidewaysGrid.anchorPrice * (1 + i * SIDEWAYS_GRID_STEP_PERCENT);
        if (currentMarketPrice >= shortTrig && !sidewaysGrid.activeGridPositions.find(p => p.side === 'SHORT' && p.stepIndex === i && p.originalAnchorPrice === sidewaysGrid.anchorPrice)) {
            addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(4)}) chạm bước SHORT ${i} (${shortTrig.toFixed(4)}) của anchor ${sidewaysGrid.anchorPrice.toFixed(4)}.`);
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, 'SHORT', shortTrig, i);
        }
        const longTrig = sidewaysGrid.anchorPrice * (1 - i * SIDEWAYS_GRID_STEP_PERCENT);
        if (currentMarketPrice <= longTrig && !sidewaysGrid.activeGridPositions.find(p => p.side === 'LONG' && p.stepIndex === i && p.originalAnchorPrice === sidewaysGrid.anchorPrice)) {
            addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(4)}) chạm bước LONG ${i} (${longTrig.toFixed(4)}) của anchor ${sidewaysGrid.anchorPrice.toFixed(4)}.`);
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, 'LONG', longTrig, i);
        }
    }
    
    if (currentMarketPrice > sidewaysGrid.gridUpperLimit || currentMarketPrice < sidewaysGrid.gridLowerLimit) {
        addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(4)}) vượt khung [${sidewaysGrid.gridLowerLimit.toFixed(4)} - ${sidewaysGrid.gridUpperLimit.toFixed(4)}]. Di chuyển lưới.`);
        sidewaysGrid.anchorPrice = currentMarketPrice;
        sidewaysGrid.gridUpperLimit = sidewaysGrid.anchorPrice * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
        sidewaysGrid.gridLowerLimit = sidewaysGrid.anchorPrice * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
        sidewaysGrid.lastGridMoveTime = Date.now();
        addLog(`[LƯỚI] Khung lưới MỚI: Anchor ${sidewaysGrid.anchorPrice.toFixed(4)}, Range [${sidewaysGrid.gridLowerLimit.toFixed(4)} - ${sidewaysGrid.gridUpperLimit.toFixed(4)}]`);
    }

    if (Date.now() - sidewaysGrid.lastVolatilityCheckTime > SIDEWAYS_VOLATILITY_CHECK_INTERVAL_MS) {
        sidewaysGrid.lastVolatilityCheckTime = Date.now();
        const currentVol = await calculateVolatilityLastHour(TARGET_COIN_SYMBOL); // Sử dụng hàm mới
        addLog(`[LƯỚI] Kiểm tra biến động 1 giờ qua: ${lastCalculatedVolatility.toFixed(2)}%`);
        if (lastCalculatedVolatility >= SIDEWAYS_VOLATILITY_THRESHOLD) {
            addLog(`[LƯỚI] Biến động mạnh (${lastCalculatedVolatility.toFixed(2)}% >= ${SIDEWAYS_VOLATILITY_THRESHOLD}%). Chuẩn bị chuyển sang KILL mode.`);
            sidewaysGrid.isClearingForKillSwitch = true;
            await closeAllSidewaysPositionsAndOrders("Chuyển sang KILL do biến động mạnh");
            addLog(`[LƯỚI] Đã đóng hết lệnh Sideways. Chờ ${KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS / 1000}s trước khi kích hoạt KILL mode.`);
            if(sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout);
            sidewaysGrid.killSwitchDelayTimeout = setTimeout(async () => {
                addLog(`[LƯỚI] Hết thời gian chờ. Kích hoạt KILL mode.`);
                currentBotMode = 'kill';
                sidewaysGrid.isClearingForKillSwitch = false;
                if (currentLongPosition) currentLongPosition = null; if (currentShortPosition) currentShortPosition = null;
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                if (botRunning) scheduleNextMainCycle();
            }, KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS);
            return;
        }
    }
}

async function closeAllSidewaysPositionsAndOrders(reason) {
    addLog(`[LƯỚI] Đóng tất cả vị thế và lệnh chờ của Sideways. Lý do: ${reason}`);
    const activePosCopy = [...sidewaysGrid.activeGridPositions];
    for (const pos of activePosCopy) {
        if (pos.tpOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.tpOrderId }); } catch (e) {} }
        if (pos.slOrderId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.slOrderId }); } catch (e) {} }
    }
    await sleep(500);
    for (const pos of activePosCopy) {
        await closeSpecificGridPosition(pos, `Đóng toàn bộ: ${reason}`); await sleep(300);
    }
    sidewaysGrid.isActive = false;
    sidewaysGrid.anchorPrice = null;
    addLog("[LƯỚI] Đã hoàn tất đóng và reset trạng thái lưới (ngoại trừ stats).");
}

async function runTradingLogic() {
    if (!botRunning || sidewaysGrid.isClearingForKillSwitch) return;

    const currentVol = await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
    const prevMode = currentBotMode;

    if (currentVol <= SIDEWAYS_VOLATILITY_THRESHOLD && !sidewaysGrid.isActive && !currentLongPosition && !currentShortPosition) {
        currentBotMode = 'sideways';
    } else if (currentVol > SIDEWAYS_VOLATILITY_THRESHOLD && currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        // Để manageSidewaysGridLogic xử lý chuyển mode nếu vol tăng
    } else if (currentVol > SIDEWAYS_VOLATILITY_THRESHOLD && currentBotMode !== 'kill') { // Nếu không phải kill và vol cao
        if (sidewaysGrid.isActive) { /* để manageSidewaysGridLogic xử lý */ }
        else { currentBotMode = 'kill'; } // Nếu không active sideways thì chuyển kill
    }
    // Nếu vol thấp nhưng đang kill, giữ kill.
    // Nếu mode không đổi nhưng là lần chạy đầu, hoặc từ kill -> sideways
    if (prevMode !== currentBotMode) {
        addLog(`Chế độ thay đổi từ ${prevMode.toUpperCase()} sang ${currentBotMode.toUpperCase()} (Vol 1h qua: ${lastCalculatedVolatility.toFixed(2)}%)`);
    }

    if (currentBotMode === 'sideways') {
        if (!sidewaysGrid.isActive) {
            if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isClearingForKillSwitch) {
                addLog('[LƯỚI] Kích hoạt chế độ Sideways từ runTradingLogic.');
                const priceAnchor = await getCurrentPrice(TARGET_COIN_SYMBOL);
                if (!priceAnchor) { addLog("[LƯỚI] Không lấy được giá để kích hoạt Sideways. Thử lại."); if(botRunning) scheduleNextMainCycle(); return; }
                sidewaysGrid.isActive = true;
                sidewaysGrid.anchorPrice = priceAnchor;
                sidewaysGrid.gridUpperLimit = priceAnchor * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
                sidewaysGrid.gridLowerLimit = priceAnchor * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
                sidewaysGrid.lastGridMoveTime = Date.now();
                sidewaysGrid.lastVolatilityCheckTime = Date.now();
                sidewaysGrid.activeGridPositions = [];
                sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                addLog(`[LƯỚI] Đã kích hoạt. Anchor: ${sidewaysGrid.anchorPrice.toFixed(4)}, Range: [${sidewaysGrid.gridLowerLimit.toFixed(4)} - ${sidewaysGrid.gridUpperLimit.toFixed(4)}]`);
                if (!positionCheckInterval) {
                     positionCheckInterval = setInterval(async () => {
                         if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
                             try { await manageOpenPosition(); }
                             catch (e) { if(e instanceof CriticalApiError) stopBotLogicInternal(); else addLog("Lỗi interval manageOpenPosition: " + e.message);}
                         } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                             clearInterval(positionCheckInterval); positionCheckInterval = null;
                         }
                     }, 7000);
                }
            } else { addLog("[LƯỚI] Đang có lệnh Kill hoặc đang dọn Sideways, chưa kích hoạt Sideways mới."); if(botRunning) scheduleNextMainCycle(); }
        }
        return;
    }

    if (currentLongPosition || currentShortPosition || sidewaysGrid.isActive) return;
    
    addLog('Bắt đầu chu kỳ giao dịch KILL mới...');
    try {
        const maxLev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLev) { if (botRunning) scheduleNextMainCycle(); return; }
        const priceNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (!priceNewPair) { if (botRunning) scheduleNextMainCycle(); return; }
        currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLev, priceNewPair);
        if (!currentLongPosition) { if (botRunning) scheduleNextMainCycle(); return; }
        await sleep(800);
        currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLev, priceNewPair);
        if (!currentShortPosition) {
            if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT đối ứng', 'LONG');
            currentLongPosition = null; if (botRunning) scheduleNextMainCycle(); return;
        }
        await sleep(1000); await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
        let tpslSet = true;
        if (currentLongPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslSet = false; }
        await sleep(300);
        if (currentShortPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslSet = false; }
        if (!tpslSet) {
             addLog("Đặt TP/SL ban đầu cho Kill Mode thất bại. Đóng cả hai.");
             if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi đặt TP/SL Kill', 'LONG');
             if (currentShortPosition) await closePosition(currentShortPosition.symbol, 'Lỗi đặt TP/SL Kill', 'SHORT');
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return;
        }
        if (!positionCheckInterval) {
             positionCheckInterval = setInterval(async () => {
                 if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
                     try { await manageOpenPosition(); }
                     catch (e) { if(e instanceof CriticalApiError) stopBotLogicInternal(); else addLog("Lỗi interval manageOpenPosition: " + e.message); }
                 } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                     clearInterval(positionCheckInterval); positionCheckInterval = null;
                 }
             }, 7000);
        }
    } catch (err) { 
        if(err instanceof CriticalApiError) stopBotLogicInternal(); 
        else addLog("Lỗi trong runTradingLogic (Kill): " + (err.msg || err.message));
        if(botRunning) scheduleNextMainCycle(); 
    }
}

const manageOpenPosition = async () => {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForKillSwitch) return;
    if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        await manageSidewaysGridLogic();
    } else if (currentBotMode === 'kill') {
        if (!currentLongPosition || !currentShortPosition) {
            if (!currentLongPosition && !currentShortPosition && botRunning) { await cleanupAndResetCycle(TARGET_COIN_SYMBOL); }
            return;
        }
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            let longPosEx = positions.find(p => p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0);
            let shortPosEx = positions.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (!longPosEx && currentLongPosition) { currentLongPosition.quantity = 0; currentLongPosition = null; }
            if (!shortPosEx && currentShortPosition) { currentShortPosition.quantity = 0; currentShortPosition = null; }
            if (!currentLongPosition || !currentShortPosition) {
                 if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                 return;
            }
            if (longPosEx && currentLongPosition) {
                currentLongPosition.unrealizedPnl = parseFloat(longPosEx.unRealizedProfit);
                currentLongPosition.currentPrice = parseFloat(longPosEx.markPrice);
                currentLongPosition.quantity = Math.abs(parseFloat(longPosEx.positionAmt));
            }
            if (shortPosEx && currentShortPosition) {
                currentShortPosition.unrealizedPnl = parseFloat(shortPosEx.unRealizedProfit);
                currentShortPosition.currentPrice = parseFloat(shortPosEx.markPrice);
                currentShortPosition.quantity = Math.abs(parseFloat(shortPosEx.positionAmt));
            }
            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
            else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
            else { 
                if (currentLongPosition && currentShortPosition && currentLongPosition.partialCloseLossLevels && currentShortPosition.partialCloseLossLevels) {
                    const posChk = currentLongPosition.unrealizedPnl > currentShortPosition.unrealizedPnl ? currentLongPosition : currentShortPosition;
                    const otherP = posChk === currentLongPosition ? currentShortPosition : currentLongPosition;
                    if (otherP.quantity === 0 && otherP.hasClosedAllLossPositionAtLastLevel) {
                        const pnlPctChk = (posChk.unrealizedPnl / posChk.initialMargin) * 100;
                        const pnlBaseChk = posChk.pnlBaseForNextMoc || 0;
                        const MOC5_IDX = 4;
                        const moc5RelPnl = posChk.partialCloseLossLevels[MOC5_IDX];
                        if (moc5RelPnl !== undefined) {
                            const threshMoc5 = pnlBaseChk + moc5RelPnl;
                            if (pnlPctChk >= threshMoc5 && posChk.nextPartialCloseLossIndex > MOC5_IDX) {
                                const vol = await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
                                if (vol > SIDEWAYS_VOLATILITY_THRESHOLD) { 
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
                                }
                            }
                        }
                    }
                }
                return; 
            }

            if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0) {
                const pnlPctWin = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
                const pnlBaseWin = winningPos.pnlBaseForNextMoc || 0;
                const targetMocRelPnl = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
                if (typeof targetMocRelPnl === 'undefined') return;
                const absThreshMoc = pnlBaseWin + targetMocRelPnl;
                const MOC5_IDX = 4, MOC5_REL_PNL = winningPos.partialCloseLossLevels[MOC5_IDX];
                const MOC8_IDX = 7, MOC8_REL_PNL = winningPos.partialCloseLossLevels[MOC8_IDX];
                if (MOC5_REL_PNL === undefined || MOC8_REL_PNL === undefined) { addLog("Lỗi: partialCloseLossLevels không đúng."); return; }
                let actionTaken = false;
                if (pnlPctWin >= absThreshMoc) {
                    actionTaken = true;
                    const mocIdxReached = winningPos.nextPartialCloseLossIndex;
                    const currentVolCheck = await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
                    if (currentVolCheck <= SIDEWAYS_VOLATILITY_THRESHOLD && mocIdxReached >= MOC5_IDX) {
                        addLog(`[CHUYỂN MODE] KILL -> SIDEWAYS tại Mốc ${mocIdxReached} của ${winningPos.side}. Vol: ${currentVolCheck.toFixed(2)}%`);
                        currentBotMode = 'sideways';
                        sidewaysGrid.isClearingForKillSwitch = true;
                        if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, "Chuyển sang Sideways từ Kill", "LONG");
                        if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, "Chuyển sang Sideways từ Kill", "SHORT");
                        currentLongPosition = null; currentShortPosition = null;
                        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                        sidewaysGrid.isActive = false; sidewaysGrid.isClearingForKillSwitch = false;
                        scheduleNextMainCycle(); return; 
                    } else {
                        let qtyFrac = (mocIdxReached === MOC5_IDX) ? 0.20 : (mocIdxReached >= MOC8_IDX) ? 1.00 : 0.10;
                        if(await closePartialPosition(losingPos, qtyFrac === 1.00 ? losingPos.quantity : losingPos.initialQuantity * qtyFrac)) { winningPos.nextPartialCloseLossIndex++; }
                        if (mocIdxReached === MOC5_IDX && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL]) {
                            const lossPctSL = MOC8_REL_PNL / 100;
                            const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100;
                            const targetPnlSLLUSD = -(losingPos.initialMargin * lossPctSL) + pnlBaseLosingUSD;
                            const priceChangeSL = Math.abs(targetPnlSLLUSD) / losingPos.initialQuantity;
                            const slPrice = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeSL : losingPos.entryPrice + priceChangeSL).toFixed(losingPos.pricePrecision));
                            if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); } catch(e){} }
                            const newSL = await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: losingPos.symbol, side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: losingPos.side, type: 'STOP_MARKET',
                                stopPrice: slPrice, quantity: losingPos.quantity, timeInForce: 'GTC', closePosition: true
                            });
                            if (newSL.orderId) { losingPos.currentSLId = newSL.orderId; winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL] = true; addLog(`SL lệnh lỗ ${losingPos.side} rời về ${slPrice.toFixed(losingPos.pricePrecision)}`); }
                        }
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
                const pairEntry = winningPos.pairEntryPrice;
                const tol = (pairEntry || currentMarketPrice || 0) * 0.0005;
                if (currentMarketPrice && pairEntry && Math.abs(currentMarketPrice - pairEntry) <= tol) {
                    if (!isProcessingTrade) { await addPosition(losingPos, losingPos.closedLossAmount, "price_near_pair_entry_reopen"); }
                }
            }
        } catch (err) { 
            addLog("Lỗi manageOpenPosition (Kill): " + (err.msg || err.message));
            if(err instanceof CriticalApiError) stopBotLogicInternal(); 
        }
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

    if (sidewaysGrid.isActive) {
        const matchedGrid = sidewaysGrid.activeGridPositions.find(p => p.tpOrderId === ordId || p.slOrderId === ordId);
        if (matchedGrid) {
            const isTp = matchedGrid.tpOrderId === ordId, isSl = matchedGrid.slOrderId === ordId;
            if (isTp) { addLog(`[LƯỚI] TP ${ordId} của ${matchedGrid.side} ${matchedGrid.entryPrice.toFixed(4)} khớp! PNL: ${rPnl.toFixed(4)}`); await closeSpecificGridPosition(matchedGrid, "TP lưới khớp", false, true); }
            else if (isSl) { addLog(`[LƯỚI] SL ${ordId} của ${matchedGrid.side} ${matchedGrid.entryPrice.toFixed(4)} khớp! PNL: ${rPnl.toFixed(4)}`); await closeSpecificGridPosition(matchedGrid, "SL lưới khớp", true, false); }
            if(!wasProc) isProcessingTrade = false; return;
        }
    }

    const isLongCloseKill = currentLongPosition && (ordId == currentLongPosition.currentTPId || ordId == currentLongPosition.currentSLId);
    const isShortCloseKill = currentShortPosition && (ordId == currentShortPosition.currentTPId || ordId == currentShortPosition.currentSLId);
    if (currentBotMode === 'kill' && (isLongCloseKill || isShortCloseKill)) {
        addLog(`Lệnh KILL ${ordId} (${posSide}) khớp.`);
        const closedSide = posSide; const remainingPos = (closedSide === 'LONG') ? currentShortPosition : currentLongPosition;
        if (closedSide === 'LONG') currentLongPosition = null; else currentShortPosition = null;
        if (rPnl >= 0) {
             addLog(`Vị thế LÃI KILL (${closedSide}) đóng. Đóng vị thế LỖ đối ứng.`);
             if (remainingPos?.quantity > 0) {
                 try {
                     const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPos.symbol });
                     const qtyEx = Math.abs(parseFloat(positions.find(p => p.symbol === remainingPos.symbol && p.positionSide === remainingPos.side)?.positionAmt || 0));
                     if (qtyEx > 0) { await closePosition(remainingPos.symbol, `Lãi KILL (${closedSide}) chốt`, remainingPos.side); }
                 } catch(e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); }
             }
             await cleanupAndResetCycle(sym);
        } else { addLog(`Vị thế LỖ KILL (${closedSide}) đóng. Lệnh còn lại (${remainingPos ? remainingPos.side : 'Không'}) chạy tiếp.`); }
    } else if (currentBotMode === 'kill') {
        addLog(`[KILL] Lệnh ${ordId} (không phải TP/SL chính) khớp. PNL: ${rPnl.toFixed(4)}`);
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
    if (sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) { // Nếu đang dọn để chuyển kill thì không reset lại
        await closeAllSidewaysPositionsAndOrders("Dọn dẹp chu kỳ (không phải chuyển mode)");
    } else if (sidewaysGrid.isClearingForKillSwitch) {
        addLog("Đang trong quá trình dọn Sideways để chuyển Kill, không reset thêm.");
    }
    currentLongPosition = null; currentShortPosition = null;
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    await cancelAllOpenOrdersForSymbol(symbol);
    await checkAndHandleRemainingPosition(symbol);
    if (botRunning && !sidewaysGrid.isClearingForKillSwitch) { // Chỉ schedule nếu không đang chờ delay chuyển mode
        scheduleNextMainCycle();
    }
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.';
    if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.';
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime(); await getExchangeInfo();
        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
        totalProfit=0; totalLoss=0; netPNL=0; currentLongPosition = null; currentShortPosition = null;
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL); // Lấy vol ban đầu
        // currentBotMode sẽ được quyết định trong runTradingLogic() đầu tiên
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey); else addLog("Không lấy được listenKey.");
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        scheduleNextMainCycle(); return 'Bot khởi động thành công.';
    } catch (err) {
        stopBotLogicInternal();
        if (err instanceof CriticalApiError && !retryBotTimeout) { retryBotTimeout = setTimeout(async () => { retryBotTimeout = null; await startBotLogicInternal(); }, ERROR_RETRY_DELAY_MS); }
        return `Lỗi khởi động bot: ${err.msg || err.message}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) return 'Bot không chạy.';
    addLog('--- Dừng Bot ---');
    botRunning = false; clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    if (sidewaysGrid.killSwitchDelayTimeout) { clearTimeout(sidewaysGrid.killSwitchDelayTimeout); sidewaysGrid.killSwitchDelayTimeout = null; } // Hủy delay nếu có
    // Không gọi closeAllSidewaysPositionsAndOrders() ở đây vì nó là async. Chỉ reset trạng thái.
    // Lệnh thực tế sẽ đóng khi bot khởi động lại qua checkAndHandleRemainingPosition.
    sidewaysGrid.isActive = false; sidewaysGrid.activeGridPositions = []; sidewaysGrid.isClearingForKillSwitch = false;
    if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
    if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.close(); userDataWs = null; }
    listenKey = null; currentLongPosition = null; currentShortPosition = null;
    isProcessingTrade = false; consecutiveApiErrors = 0;
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Bot đã dừng ---'); return 'Bot đã dừng.';
}

// Express App (Không thay đổi nhiều ở đây)
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
                if(sidewaysGrid.isClearingForKillSwitch) statusMsg += " (ĐANG DỌN SIDEWAYS ĐỂ CHUYỂN KILL)";
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
app.get('/api/bot_stats', (req, res) => { // Đã cập nhật ở logic trước
    let killPosData = [];
    if (currentBotMode === 'kill') {
        [currentLongPosition, currentShortPosition].forEach(p => {
            if (p) killPosData.push({
                type: 'kill', side: p.side, entry: p.entryPrice?.toFixed(p.pricePrecision || 2), qty: p.quantity?.toFixed(p.quantityPrecision || 3),
                pnl: (p.unrealizedPnl || 0).toFixed(2), curPrice: p.currentPrice?.toFixed(p.pricePrecision || 2),
                initQty: p.initialQuantity?.toFixed(p.quantityPrecision || 3), closedLoss: p.closedLossAmount?.toFixed(p.quantityPrecision || 3),
                pairEntry: p.pairEntryPrice?.toFixed(p.pricePrecision || 2), mocIdx: p.nextPartialCloseLossIndex, pnlBase: (p.pnlBaseForNextMoc || 0).toFixed(2)
            });
        });
    }
    let gridPosData = [];
    if (sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0) {
        sidewaysGrid.activeGridPositions.forEach(p => {
            let pnlUnreal = 0;
            if (currentMarketPrice && p.entryPrice && p.quantity) { pnlUnreal = (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1); }
            gridPosData.push({
                type: 'grid', side: p.side, entry: p.entryPrice?.toFixed(4), qty: p.quantity?.toFixed(4),
                curPrice: currentMarketPrice?.toFixed(4), pnl: pnlUnreal.toFixed(2),
                originalAnchor: p.originalAnchorPrice?.toFixed(4), step: p.stepIndex
            });
        });
    }
    res.json({
        success: true,
        data: {
            status: botRunning ? 'CHẠY' : 'DỪNG', mode: currentBotMode.toUpperCase(), vol: lastCalculatedVolatility.toFixed(2),
            profit: totalProfit.toFixed(2), loss: totalLoss.toFixed(2), net: netPNL.toFixed(2),
            positions: killPosData, invest: INITIAL_INVESTMENT_AMOUNT, coin: TARGET_COIN_SYMBOL,
            sidewaysGridInfo: {
                isActive: sidewaysGrid.isActive, isClearing: sidewaysGrid.isClearingForKillSwitch,
                anchorPrice: sidewaysGrid.anchorPrice?.toFixed(4), upperLimit: sidewaysGrid.gridUpperLimit?.toFixed(4), lowerLimit: sidewaysGrid.gridLowerLimit?.toFixed(4),
                stats: sidewaysGrid.sidewaysStats, activePositions: gridPosData
            }
        }
    });
});
app.post('/api/configure', (req, res) => { // Đã cập nhật ở logic trước
    const { coinConfigs } = req.body; let changed = false; let msg = 'Không có thay đổi.';
    if (coinConfigs && coinConfigs.length > 0) {
        const cfg = coinConfigs[0]; let coinCfgChanged = false;
        if (cfg.symbol && cfg.symbol.trim().toUpperCase() !== TARGET_COIN_SYMBOL) { TARGET_COIN_SYMBOL = cfg.symbol.trim().toUpperCase(); coinCfgChanged = true; }
        if (cfg.initialAmount && parseFloat(cfg.initialAmount) > 0 && parseFloat(cfg.initialAmount) !== INITIAL_INVESTMENT_AMOUNT) { INITIAL_INVESTMENT_AMOUNT = parseFloat(cfg.initialAmount); coinCfgChanged = true; }
        if (coinCfgChanged) {
            changed = true; msg = 'Cấu hình coin/vốn đã cập nhật.'; addLog(msg);
            totalProfit = 0; totalLoss = 0; netPNL = 0;
            sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
            if (botRunning) { addLog("Bot đang chạy, sẽ dừng. Vui lòng khởi động lại."); const stopMsgTxt = stopBotLogicInternal(); msg += ` ${stopMsgTxt} Vui lòng khởi động lại bot.`; }
        }
    }
    res.json({ success: changed, message: msg });
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(stopBotLogicInternal()));
app.listen(WEB_SERVER_PORT, () => addLog(`Web server: http://localhost:${WEB_SERVER_PORT}`));
