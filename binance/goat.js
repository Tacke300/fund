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

// --- CÁC BIẾN CẤU HÌNH ---
const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WEB_SERVER_PORT = 1277;
const THIS_BOT_PM2_NAME = 'goat';
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;
const MAX_CONSECUTIVE_API_ERRORS = 5;
const ERROR_RETRY_DELAY_MS = 15000;

// --- BIẾN TRẠNG THÁI TOÀN CỤC ---
let serverTimeOffset = 0;
let exchangeInfoCache = null;
let isProcessingTrade = false;
let botRunning = false;
let botStartTime = null;

// BIẾN CHO CHẾ ĐỘ KILL (LOGIC GỐC)
let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;
let consecutiveApiErrors = 0;
let retryBotTimeout = null;
const logCounts = {};
const LOG_COOLDOWN_MS = 2000;
let currentBotMode = 'kill';
let last30mVolatility = 0; // Đổi từ lastHourVolatility
let INITIAL_INVESTMENT_AMOUNT = 10;
let TARGET_COIN_SYMBOL = 'ETHUSDT';
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;
let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null;

// --- CÁC BIẾN CHO BOT LƯỚI (SIDEWAYS MODE) ---
let isGridBotActive = false;
let gridConfig = {}; 
let gridStats = {
    totalGridsMatched: 0,
    totalTpHit: 0,
    totalSlHit: 0,
    totalSlLoss: 0,
};
const GRID_RANGE_PERCENT = 0.05;
const GRID_STEP_PERCENT = 0.005;
const GRID_INITIAL_TRIGGER_PERCENT = 0.005;
const GRID_ORDER_SIZE_RATIO = 0.20;
const VOLATILITY_CHECK_INTERVAL_MS = 60000;

// --- LỚP LỖI & CÁC HÀM TIỆN ÍCH ---
class CriticalApiError extends Error { constructor(message) { super(message); this.name = 'CriticalApiError'; } }
function addLog(message) { const now = new Date(); const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`; const logEntry = `[${time}] ${message}`; console.log(logEntry); if (LOG_TO_CUSTOM_FILE) { fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {}); } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }
async function makeHttpRequest(method, hostname, path, headers, postData = '') { return new Promise((resolve, reject) => { const options = { hostname, path, method, headers }; const req = https.request(options, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data); } else { let errorDetails = { code: res.statusCode, msg: `Lỗi HTTP: ${res.statusCode}` }; try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; } catch (e) {} addLog(`Lỗi Request HTTP: ${errorDetails.msg}`); reject(errorDetails); } }); }); req.on('error', (e) => { addLog(`Lỗi Mạng: ${e.message}`); reject({ code: 'NETWORK_ERROR', msg: e.message }); }); if (postData) req.write(postData); req.end(); }); }

// --- CÁC HÀM GỌI API BINANCE ---
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) { if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Thiếu API/SECRET key."); const timestamp = Date.now() + serverTimeOffset; const recvWindow = 5000; let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&'); queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`; const signature = createSignature(queryString, SECRET_KEY); let requestPath, requestBody = ''; const headers = { 'X-MBX-APIKEY': API_KEY }; if (method === 'GET' || method === 'DELETE') { requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`; } else { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; } try { const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody); consecutiveApiErrors = 0; return JSON.parse(rawData); } catch (error) { consecutiveApiErrors++; addLog(`Lỗi API Binance (${method} ${fullEndpointPath}): ${error.msg || error.message}`); if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) { addLog(`Quá nhiều lỗi API liên tiếp. Dừng bot.`); throw new CriticalApiError("Quá nhiều lỗi API."); } throw error; } }
async function callPublicAPI(fullEndpointPath, params = {}) { const queryString = new URLSearchParams(params).toString(); const fullPathWithQuery = `${fullEndpointPath}?${queryString}`; try { const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, {}); return JSON.parse(rawData); } catch (error) { addLog(`Lỗi API Công Khai: ${error.msg || error.message}`); throw error; } }
async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function get30mVolatility(symbol) { try { const klines = await callPublicAPI('/fapi/v1/klines', { symbol: symbol, interval: '30m', limit: 2 }); if (klines && klines.length > 0) { const candle = klines[0]; const high = parseFloat(candle[2]), low = parseFloat(candle[3]); if (low > 0) { const volatility = ((high - low) / low) * 100; last30mVolatility = volatility; return volatility; } } return 0; } catch (e) { addLog(`Lỗi khi lấy dữ liệu biến động 30p: ${e.message}`); if (e instanceof CriticalApiError) throw e; return 0; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); return r.find(i => i.symbol === symbol)?.brackets[0]?.initialLeverage || null; } catch (e) { return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize), stepSize: parseFloat(l?.stepSize), minNotional: parseFloat(m?.notional) }; }); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { return parseFloat((await callPublicAPI('/fapi/v1/ticker/price', { symbol })).price); } catch (e) { return null; } }
async function cancelAllOpenOrdersForSymbol(symbol) { addLog(`Hủy TẤT CẢ lệnh chờ cho ${symbol}...`); try { await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol }); } catch (error) { if (error.code !== -2011) addLog(`Lỗi hủy lệnh chờ: ${error.msg}`); } }

// --- LOGIC QUẢN LÝ VỊ THẾ CHUNG ---
async function closePosition(symbol, reason, positionSide) {
    if (!symbol || !positionSide) return { success: false, pnl: 0 };
    addLog(`Đang đóng ${positionSide} trên ${symbol} (Lý do: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);
        if (pos) {
            const qty = Math.abs(parseFloat(pos.positionAmt));
            if (qty === 0) return { success: false, pnl: 0 };
            const side = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            const res = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side, positionSide, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
            
            if(positionSide === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
            if(positionSide === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;

            const realizedPnl = res.fills?.reduce((sum, fill) => sum + parseFloat(fill.realizedPnl), 0) || 0;
            return { success: true, pnl: realizedPnl };
        }
        return { success: false, pnl: 0 };
    } catch (error) {
        addLog(`Lỗi khi đóng ${positionSide}: ${error.msg}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return { success: false, pnl: 0 };
    }
}
async function cleanupAndResetCycle(symbol) {
    addLog(`Chu kỳ của ${symbol} đã kết thúc. Đang dọn dẹp...`);
    if (isGridBotActive) {
        await closeAllGridPositionsAndOrders(false);
    }
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
async function checkAndHandleRemainingPosition(symbol) {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        for (const pos of positions) {
            if (parseFloat(pos.positionAmt) !== 0) {
                addLog(`Phát hiện vị thế còn sót: ${pos.positionSide} ${pos.positionAmt}. Đang đóng...`);
                await closePosition(pos.symbol, `Dọn dẹp vị thế sót`, pos.positionSide);
                await sleep(500);
            }
        }
    } catch (error) {
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

// --- LOGIC BOT LƯỚI (SIDEWAYS MODE) ---
async function startSidewaysGridBot() { if (isGridBotActive) return; addLog("[LƯỚI] Kích hoạt chế độ Bot Lưới (Sideways)."); isGridBotActive = true; const triggerPrice = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!triggerPrice) { addLog("[LƯỚI] LỖI: Không lấy được giá để bắt đầu. Thử lại sau..."); isGridBotActive = false; scheduleNextMainCycle(); return; } gridConfig = { triggerPrice, upperBound: triggerPrice * (1 + GRID_RANGE_PERCENT), lowerBound: triggerPrice * (1 - GRID_RANGE_PERCENT), isInitialOrderPlaced: false, orders: [], activePositions: [], lastVolatilityCheckTime: Date.now() }; addLog(`[LƯỚI] Cài đặt xong. Giá kích hoạt: ${triggerPrice.toFixed(4)}. Phạm vi: ${gridConfig.lowerBound.toFixed(4)} - ${gridConfig.upperBound.toFixed(4)}.`); addLog(`[LƯỚI] Chờ giá biến động ${GRID_INITIAL_TRIGGER_PERCENT*100}% để vào lệnh đầu tiên...`); if (!positionCheckInterval) { positionCheckInterval = setInterval(manageOpenPosition, 5000); } }
async function manageSidewaysGrid() { if (!isGridBotActive || !gridConfig.triggerPrice || currentMarketPrice === null) return; if (!gridConfig.isInitialOrderPlaced) { let side = null; if (currentMarketPrice >= gridConfig.triggerPrice * (1 + GRID_INITIAL_TRIGGER_PERCENT)) side = 'SHORT'; else if (currentMarketPrice <= gridConfig.triggerPrice * (1 - GRID_INITIAL_TRIGGER_PERCENT)) side = 'LONG'; if (side) { addLog(`[LƯỚI] Giá đã chạm mốc kích hoạt. Mở vị thế ${side} đầu tiên và giăng lưới.`); gridConfig.isInitialOrderPlaced = true; await setupGridOrders(side); } return; } if (Date.now() - (gridConfig.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS) { gridConfig.lastVolatilityCheckTime = Date.now(); const vol = await get30mVolatility(TARGET_COIN_SYMBOL); if (vol > 5) { addLog(`[CHUYỂN ĐỔI] Biến động mạnh (${vol.toFixed(2)}% > 5%). Chuyển từ SIDEWAYS sang KILL.`); currentBotMode = 'kill'; await closeAllGridPositionsAndOrders(false); isGridBotActive = false; scheduleNextMainCycle(); return; } } const positionsToClose = gridConfig.activePositions.filter(p => (p.side === 'LONG' && currentMarketPrice <= gridConfig.lowerBound) || (p.side === 'SHORT' && currentMarketPrice >= gridConfig.upperBound)); for (const pos of positionsToClose) await closePositionForGridSL(pos); }
async function setupGridOrders(initialSide) { try { const details = await getSymbolDetails(TARGET_COIN_SYMBOL); const lev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL); if (!details || !lev) throw new Error("Không lấy được chi tiết symbol/đòn bẩy."); await setLeverage(TARGET_COIN_SYMBOL, lev); const gridSizeUSD = INITIAL_INVESTMENT_AMOUNT * GRID_ORDER_SIZE_RATIO; let qty = (gridSizeUSD * lev) / gridConfig.triggerPrice; qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision)); if (qty * gridConfig.triggerPrice < details.minNotional) throw new Error(`Kích thước lưới quá nhỏ.`); await callSignedAPI('/fapi/v1/order', 'POST', { symbol: TARGET_COIN_SYMBOL, side: (initialSide === 'LONG' ? 'BUY' : 'SELL'), positionSide: initialSide, type: 'MARKET', quantity: qty }); addLog(`[LƯỚI] Đã mở lệnh MARKET ${initialSide} đầu tiên.`); gridStats.totalGridsMatched++; await sleep(1500); const totalLines = Math.floor(GRID_RANGE_PERCENT / GRID_STEP_PERCENT); let placed = []; for (let i = 1; i <= totalLines; i++) { const longPrice = parseFloat((gridConfig.triggerPrice * (1 - i * GRID_STEP_PERCENT)).toFixed(details.pricePrecision)); if (longPrice >= gridConfig.lowerBound) try { const o = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: TARGET_COIN_SYMBOL, side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: longPrice, quantity: qty, timeInForce: 'GTC' }); placed.push({ orderId: o.orderId, price: longPrice, type: 'LONG_GRID' }); } catch (e) {} const shortPrice = parseFloat((gridConfig.triggerPrice * (1 + i * GRID_STEP_PERCENT)).toFixed(details.pricePrecision)); if (shortPrice <= gridConfig.upperBound) try { const o = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: TARGET_COIN_SYMBOL, side: 'SELL', positionSide: 'SHORT', type: 'LIMIT', price: shortPrice, quantity: qty, timeInForce: 'GTC' }); placed.push({ orderId: o.orderId, price: shortPrice, type: 'SHORT_GRID' }); } catch (e) {} } gridConfig.orders = placed; addLog(`[LƯỚI] Đã giăng ${placed.length} lệnh limit.`); } catch (error) { addLog(`[LƯỚI] LỖI NGHIÊM TRỌNG khi cài đặt lưới: ${error.message}. Đóng lưới.`); await closeAllGridPositionsAndOrders(false); } }
async function closePositionForGridSL(pos) { addLog(`[LƯỚI] Vị thế ${pos.side} tại ${pos.entryPrice} chạm biên SL. Đang đóng...`); const res = await closePosition(TARGET_COIN_SYMBOL, 'Lưới chạm SL', pos.side); if (res.success) { gridStats.totalSlHit++; gridStats.totalSlLoss += res.pnl; totalLoss += Math.abs(res.pnl); netPNL += res.pnl; addLog(`[LƯỚI] Vị thế SL đã đóng. PNL: ${res.pnl.toFixed(4)}. Tổng lỗ từ SL lưới: ${gridStats.totalSlLoss.toFixed(4)}`); gridConfig.activePositions = gridConfig.activePositions.filter(p => p.id !== pos.id); if (pos.tpOrderId) try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.tpOrderId }); } catch (e) {} } else { addLog(`[LƯỚI] Không đóng được vị thế SL.`); } }
async function closeAllGridPositionsAndOrders(andRestart = false) { addLog("[LƯỚI] Đang đóng tất cả vị thế và lệnh của lưới..."); isGridBotActive = false; await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500); await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL); gridConfig = {}; addLog("[LƯỚI] Dọn dẹp xong."); if (botRunning && andRestart) { addLog("[LƯỚI] Khởi động lại chu trình lưới..."); await startSidewaysGridBot(); } }

// --- LOGIC CHO KILL MODE (LOGIC GỐC CỦA BẠN) ---
async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    addLog(`[KILL] Đang mở ${tradeDirection} trên ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) throw new Error("Lỗi lấy chi tiết symbol.");
        
        const priceToUseForCalc = entryPriceOverride || await getCurrentPrice(symbol);
        if (!priceToUseForCalc) throw new Error("Lỗi lấy giá hiện tại.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceToUseForCalc;
        quantity = parseFloat((Math.floor(quantity / symbolDetails.stepSize) * symbolDetails.stepSize).toFixed(symbolDetails.quantityPrecision));

        if (quantity * priceToUseForCalc < symbolDetails.minNotional) {
             throw new Error("Giá trị lệnh quá nhỏ so với sàn.");
        }
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (tradeDirection === 'LONG' ? 'BUY' : 'SELL'), positionSide: tradeDirection, type: 'MARKET', quantity });

        await sleep(2000); 
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (!openPos) throw new Error("Vị thế chưa xác nhận trên sàn.");

        const actualEntryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`[KILL] Đã mở ${tradeDirection} | KL: ${actualQuantity.toFixed(symbolDetails.quantityPrecision)} | Giá vào: ${actualEntryPrice.toFixed(symbolDetails.pricePrecision)}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, 
            entryPrice: actualEntryPrice, initialMargin: INITIAL_INVESTMENT_AMOUNT,
            side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: symbolDetails.pricePrecision, quantityPrecision: symbolDetails.quantityPrecision,
            closedLossAmount: 0, nextPartialCloseLossIndex: 0, pnlBaseForNextMoc: 0,
            hasAdjustedSLToSpecificLevel: {}, hasClosedAllLossPositionAtLastLevel: false,
            pairEntryPrice: priceToUseForCalc, currentTPId: null, currentSLId: null, unrealizedPnl: 0,
        };
    } catch (error) {
        addLog(`[KILL] Lỗi mở ${tradeDirection}: ${error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return null;
    }
}
async function setTPAndSLForPosition(position, isFullResetEvent = false) {
    if (!position || position.quantity <= 0) return false;
    const symbolDetails = await getSymbolDetails(position.symbol);
    if(!symbolDetails) { addLog("[KILL] Không có chi tiết symbol để đặt TP/SL"); return false;}

    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity, pnlBaseForNextMoc = 0 } = position;
    addLog(`[KILL] Đặt/Reset TP/SL cho ${side} | Entry: ${entryPrice.toFixed(pricePrecision)} | KL: ${quantity.toFixed(position.quantityPrecision)}`);

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
        
        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (side === 'LONG' ? 'SELL' : 'BUY'), positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity, timeInForce: 'GTC' });
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (side === 'LONG' ? 'SELL' : 'BUY'), positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity, timeInForce: 'GTC' });

        addLog(`[KILL] TP/SL cho ${side}: TP=${tpPrice.toFixed(pricePrecision)}, SL=${slPrice.toFixed(pricePrecision)}`);
        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        position.partialCloseLossLevels = partialCloseLossSteps;
        
        return true;
    } catch (error) {
        addLog(`[KILL] Lỗi đặt TP/SL cho ${side}: ${error.message}.`);
        return false;
    }
}
async function closePartialPosition(position, quantityToClose) { /* Giữ nguyên hàm gốc của bạn */ }
async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") { /* Giữ nguyên hàm gốc của bạn */ }

// --- LOGIC CHÍNH & QUẢN LÝ BOT ---
async function runTradingLogic() {
    if (!botRunning || isGridBotActive || currentLongPosition || currentShortPosition) return;
    addLog('Bắt đầu chu kỳ giao dịch mới...');
    try {
        const vol = await get30mVolatility(TARGET_COIN_SYMBOL);
        currentBotMode = (vol <= 3) ? 'sideways' : 'kill';
        addLog(`Chế độ được chọn: ${currentBotMode.toUpperCase()} (Biến động 30p: ${vol.toFixed(2)}%)`);

        if (currentBotMode === 'sideways') {
            await startSidewaysGridBot();
            return;
        } 
        
        if (currentBotMode === 'kill') {
            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) { scheduleNextMainCycle(); return; }
            await setLeverage(TARGET_COIN_SYMBOL, maxLeverage);
            
            const priceForNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL);
            
            currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLeverage, priceForNewPair);
            await sleep(500);
            currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLeverage, priceForNewPair);

            if(!currentLongPosition || !currentShortPosition){
                addLog("[KILL] Không mở được một trong hai vị thế. Dọn dẹp...");
                if(currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, 'Lỗi cài đặt Kill', 'LONG');
                if(currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, 'Lỗi cài đặt Kill', 'SHORT');
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                return;
            }

            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            await sleep(500);

            await setTPAndSLForPosition(currentLongPosition, true);
            await setTPAndSLForPosition(currentShortPosition, true);

            if (!positionCheckInterval) {
                 positionCheckInterval = setInterval(manageOpenPosition, 5000);
            }
        }
    } catch (error) {
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        if(botRunning) scheduleNextMainCycle();
    }
}
const manageOpenPosition = async () => {
    // Phân luồng logic
    if (isGridBotActive) {
        await manageSidewaysGrid();
        return;
    }
    
    // Logic của KILL MODE
    if (currentBotMode === 'kill') {
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

            if (!longPosOnExchange && currentLongPosition) { currentLongPosition = null; }
            if (!shortPosOnExchange && currentShortPosition) { currentShortPosition = null; }
            
            if (!currentLongPosition || !currentShortPosition) { return; }

            currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
            currentLongPosition.currentPrice = parseFloat(longPosOnExchange.markPrice);
            currentLongPosition.quantity = Math.abs(parseFloat(longPosOnExchange.positionAmt));
            
            currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
            currentShortPosition.currentPrice = parseFloat(shortPosOnExchange.markPrice);
            currentShortPosition.quantity = Math.abs(parseFloat(shortPosOnExchange.positionAmt));
            
            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
            else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
            else { return; }
            
            // --- LOGIC GỐC PHỨC TẠP CỦA BẠN ĐƯỢC GIỮ LẠI TẠI ĐÂY ---
            if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0) {
                const actualPnlPercentageOfWinningPos = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
                const pnlBaseForWinningPos = winningPos.pnlBaseForNextMoc || 0;
                const targetMocPnlPercentage_Relative = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
                
                if (typeof targetMocPnlPercentage_Relative === 'undefined') {
                    return;
                }
                const absolutePnlPercentageThresholdForNextMoc = pnlBaseForWinningPos + targetMocPnlPercentage_Relative;

                const PARTIAL_CLOSE_INDEX_5 = 4;
                const PARTIAL_CLOSE_LEVEL_5_RELATIVE = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5];
                const PARTIAL_CLOSE_INDEX_8 = 7;
                const PARTIAL_CLOSE_LEVEL_8_RELATIVE = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8];

                let actionTakenAtMoc = false;

                if (actualPnlPercentageOfWinningPos >= absolutePnlPercentageThresholdForNextMoc) {
                    actionTakenAtMoc = true;
                    const currentMocIndexReached = winningPos.nextPartialCloseLossIndex;
                    
                    let qtyFrac = (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5) ? 0.20 : (currentMocIndexReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10;
                    if(await closePartialPosition(losingPos, qtyFrac === 1.00 ? losingPos.quantity : losingPos.initialQuantity * qtyFrac)) winningPos.nextPartialCloseLossIndex++;
                    
                    if (currentMocIndexReached === PARTIAL_CLOSE_INDEX_5 && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE]) {
                        const lossPercentageForSL = PARTIAL_CLOSE_LEVEL_8_RELATIVE / 100;
                        const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100;
                        const targetPnlSLLosingUSD = -(losingPos.initialMargin * lossPercentageForSL) + pnlBaseLosingUSD;
                        const priceChangeSLLosing = Math.abs(targetPnlSLLosingUSD) / losingPos.initialQuantity;
                        const slPriceLosing = parseFloat((losingPos.side === 'LONG' ? losingPos.entryPrice - priceChangeSLLosing : losingPos.entryPrice + priceChangeSLLosing).toFixed(losingPos.pricePrecision));
                        
                        if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); } catch(e){} }
                        const newSLOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                            symbol: losingPos.symbol, side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: losingPos.side, type: 'STOP_MARKET',
                            stopPrice: slPriceLosing, quantity: losingPos.quantity, timeInForce: 'GTC'
                        });
                        if (newSLOrder.orderId) {
                            losingPos.currentSLId = newSLOrder.orderId;
                            winningPos.hasAdjustedSLToSpecificLevel[PARTIAL_CLOSE_LEVEL_5_RELATIVE] = true;
                            addLog(`[KILL] SL lệnh lỗ ${losingPos.side} rời về ${slPriceLosing.toFixed(losingPos.pricePrecision)}`);
                        }
                    }
                     if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_8 && actionTakenAtMoc) ) {
                        losingPos.hasClosedAllLossPositionAtLastLevel = true;
                    }
                }
            }
        } catch(error) { if(error instanceof CriticalApiError) stopBotLogicInternal(); }
    }
};
async function scheduleNextMainCycle() { if (!botRunning || isGridBotActive || currentLongPosition || currentShortPosition) return; clearTimeout(nextScheduledCycleTimeout); nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000); }
async function processTradeResult(orderInfo) {
    const { s: symbol, i: orderId, X: orderStatus, S: side, ps: positionSide, z: filledQtyStr, rp: realizedPnlStr } = orderInfo;
    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') return;
    
    const filledQty = parseFloat(filledQtyStr);
    const realizedPnl = parseFloat(realizedPnlStr);

    if (isGridBotActive) {
        const matchedGridOrder = gridConfig.orders?.find(o => o.orderId === orderId);
        if (matchedGridOrder) { gridStats.totalGridsMatched++; addLog(`[LƯỚI] Khớp lệnh: ${matchedGridOrder.type} ${side} ${filledQty} @ ${orderInfo.L}`); gridConfig.orders = gridConfig.orders.filter(o => o.orderId !== orderId); const pos = { id: orderId, side: positionSide, entryPrice: parseFloat(orderInfo.L), quantity: filledQty, tpOrderId: null }; gridConfig.activePositions.push(pos); const details = await getSymbolDetails(symbol); const tpPrice = parseFloat((positionSide === 'LONG' ? pos.entryPrice * (1 + GRID_STEP_PERCENT) : pos.entryPrice * (1 - GRID_STEP_PERCENT)).toFixed(details.pricePrecision)); try { const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (positionSide === 'LONG' ? 'SELL' : 'BUY'), positionSide, type: 'LIMIT', price: tpPrice, quantity: filledQty, timeInForce: 'GTC' }); pos.tpOrderId = tpOrder.orderId; addLog(`[LƯỚI] Đã đặt TP cho vị thế mới tại ${tpPrice}`); } catch (e) { addLog(`[LƯỚI] Lỗi đặt TP: ${e.message}`); } return; }
        const matchedTpOrder = gridConfig.activePositions?.find(p => p.tpOrderId === orderId);
        if (matchedTpOrder) { gridStats.totalTpHit++; addLog(`[LƯỚI] Chạm TP của ${matchedTpOrder.side}! PNL: ${realizedPnl}`); if (realizedPnl !== 0) { if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl); netPNL = totalProfit - totalLoss; } gridConfig.activePositions = gridConfig.activePositions.filter(p => p.tpOrderId !== orderId); const details = await getSymbolDetails(symbol); try { const newGridOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (matchedTpOrder.side === 'LONG' ? 'BUY' : 'SELL'), positionSide: matchedTpOrder.side, type: 'LIMIT', price: matchedTpOrder.entryPrice, quantity: matchedTpOrder.quantity, timeInForce: 'GTC' }); gridConfig.orders.push({ orderId: newGridOrder.orderId, price: matchedTpOrder.entryPrice, type: `${matchedTpOrder.side}_GRID` }); addLog(`[LƯỚI] Đã đặt lại lệnh lưới tại ${matchedTpOrder.entryPrice}.`); } catch(e) { addLog(`[LƯỚI] Lỗi đặt lại lệnh lưới: ${e.message}`); } return; }
        return;
    }
    
    if (currentBotMode === 'kill') {
        const isLongClosure = currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId);
        const isShortClosure = currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId);

        if(isLongClosure || isShortClosure) {
             addLog(`[KILL] Một vị thế chính đã đóng. Dọn dẹp và reset chu kỳ.`);
             if (realizedPnl !== 0) { if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl); netPNL = totalProfit - totalLoss; }
             const remainingPos = isLongClosure ? currentShortPosition : currentLongPosition;
             if(remainingPos) {
                 await closePosition(remainingPos.symbol, `Đối ứng đã đóng`, remainingPos.side);
             }
             await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
        } else {
            if (realizedPnl !== 0) {
                 addLog(`[KILL] Lệnh từng phần/lệnh tay thực thi. PNL: ${realizedPnl.toFixed(4)}`);
                 if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl);
                 netPNL = totalProfit - totalLoss;
            }
        }
    }
}
async function startBotLogicInternal() { if (botRunning) return 'Bot đã chạy.'; if (!API_KEY || !SECRET_KEY) return 'Lỗi: Thiếu API/SECRET key.'; if (retryBotTimeout) clearTimeout(retryBotTimeout); addLog('--- Bắt Đầu Khởi Động Bot ---'); try { await syncServerTime(); await getExchangeInfo(); await closeAllGridPositionsAndOrders(false); await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); setupMarketDataStream(TARGET_COIN_SYMBOL); botRunning = true; botStartTime = new Date(); totalProfit=0; totalLoss=0; netPNL=0; gridStats = { totalGridsMatched: 0, totalTpHit: 0, totalSlHit: 0, totalSlLoss: 0 }; currentLongPosition = null; currentShortPosition = null; isGridBotActive = false; addLog(`--- Bot Đã Chạy: ${new Date().toLocaleString()} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`); scheduleNextMainCycle(); return 'Bot khởi động thành công.'; } catch (error) { stopBotLogicInternal(); if (error instanceof CriticalApiError) retryBotTimeout = setTimeout(startBotLogicInternal, ERROR_RETRY_DELAY_MS); return `Lỗi khởi động bot: ${error.message}`; } }
async function stopBotLogicInternal() { if (!botRunning) return 'Bot đang không chạy.'; addLog('--- Bắt Đầu Dừng Bot ---'); botRunning = false; clearTimeout(nextScheduledCycleTimeout); if (positionCheckInterval) clearInterval(positionCheckInterval); positionCheckInterval = null; await closeAllGridPositionsAndOrders(false); await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL); currentLongPosition=null; currentShortPosition=null; isGridBotActive=false; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; } if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.close(); userDataWs = null; } if (retryBotTimeout) clearTimeout(retryBotTimeout); addLog('--- Bot Đã Dừng ---'); return 'Bot đã dừng.'; }

// --- WEBSOCKETS & WEB SERVER ---
function setupMarketDataStream(symbol) { if (marketWs) marketWs.close(); marketWs = new WebSocket(`${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice@1s`); marketWs.onopen = () => addLog("Stream Giá Thị Trường đã kết nối."); marketWs.onmessage = (e) => { try { currentMarketPrice = parseFloat(JSON.parse(e.data).p); } catch {} }; marketWs.onclose = () => { if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); }; marketWs.onerror = (err) => addLog(`Lỗi Stream Giá: ${err.message}`); }
function setupUserDataStream(key) { if (userDataWs) userDataWs.close(); userDataWs = new WebSocket(`${WS_BASE_URL}/ws/${key}`); userDataWs.onopen = () => { addLog("Stream Dữ Liệu Người Dùng đã kết nối."); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); }; userDataWs.onmessage = async (e) => { try { const d = JSON.parse(e.data); if (d.e === 'ORDER_TRADE_UPDATE') await processTradeResult(d.o); } catch {} }; userDataWs.onclose = () => { if (botRunning) setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); }; userDataWs.onerror = (err) => addLog(`Lỗi Stream Người Dùng: ${err.message}`); }
async function keepAliveListenKey() { if (listenKey) try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) {} }
const app = express(); app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => res.send(data || '')));
app.get('/api/status', (req, res) => { let statusMsg = `BOT: ${botRunning ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}`; if (botRunning) { statusMsg += ` | Thời gian chạy: ${Math.floor((Date.now() - (botStartTime?.getTime() || Date.now())) / 60000)} phút`; statusMsg += ` | Chế độ: ${currentBotMode.toUpperCase()}`; if (currentBotMode === 'sideways') { statusMsg += ` (Lưới: ${isGridBotActive ? 'HOẠT ĐỘNG' : 'CHỜ'})`; let posText = " | Vị thế: --"; if (isGridBotActive && gridConfig.activePositions?.length > 0) { const longCount = gridConfig.activePositions.filter(p=>p.side === 'LONG').length; const shortCount = gridConfig.activePositions.filter(p=>p.side === 'SHORT').length; posText = ` | Vị thế lưới: L(${longCount}), S(${shortCount})`; } statusMsg += posText; } else { statusMsg += ` (Biến động:${last30mVolatility.toFixed(1)}%)`; let posText = " | Vị thế: --"; if (currentLongPosition || currentShortPosition) { posText = ` | Vị thế Kill: ${currentLongPosition ? 'L' : ''}${currentShortPosition ? 'S' : ''}`; } statusMsg += posText; } } res.send(statusMsg); });
app.post('/api/configure', (req, res) => { const { symbol, initialAmount } = req.body; let changed = false; if (symbol && symbol.trim().toUpperCase() !== TARGET_COIN_SYMBOL) { TARGET_COIN_SYMBOL = symbol.trim().toUpperCase(); changed = true; } if (initialAmount && parseFloat(initialAmount) > 0 && parseFloat(initialAmount) !== INITIAL_INVESTMENT_AMOUNT) { INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount); changed = true; } if (changed && botRunning) { stopBotLogicInternal(); addLog("Cấu hình thay đổi. Bot đã dừng. Vui lòng khởi động lại."); } res.json({ success: changed, message: changed ? 'Cấu hình đã cập nhật. Khởi động lại bot.' : 'Không có gì thay đổi.' }); });
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', async (req, res) => res.send(await stopBotLogicInternal()));
app.get('/api/bot_stats', (req, res) => {
    let killModePositionsData = [];
    if (currentLongPosition) killModePositionsData.push({ ...currentLongPosition });
    if (currentShortPosition) killModePositionsData.push({ ...currentShortPosition });

    let sidewaysModePositionsData = [];
    let unrealizedGridPnl = 0;
    if (isGridBotActive && gridConfig.activePositions) {
        sidewaysModePositionsData = gridConfig.activePositions.map(pos => {
            let pnl = 0;
            if (currentMarketPrice && pos.entryPrice && pos.quantity) {
                pnl = (currentMarketPrice - pos.entryPrice) * pos.quantity * (pos.side === 'LONG' ? 1 : -1);
                unrealizedGridPnl += pnl;
            }
            return { side: pos.side, entry: pos.entryPrice?.toFixed(4), qty: pos.quantity?.toFixed(4), curPrice: currentMarketPrice?.toFixed(4), pnl: pnl.toFixed(4) };
        });
    }
    res.json({
        success: true,
        data: {
            mode: currentBotMode.toUpperCase(),
            vol: last30mVolatility.toFixed(2),
            net: netPNL.toFixed(4),
            invest: INITIAL_INVESTMENT_AMOUNT,
            coin: TARGET_COIN_SYMBOL,
            killModePositions: killModePositionsData,
            sidewaysModePositions: sidewaysModePositionsData,
            gridStats,
            unrealizedGridPnl,
        }
    });
});
app.listen(WEB_SERVER_PORT, () => addLog(`Web server đang chạy tại http://localhost:${WEB_SERVER_PORT}`));
