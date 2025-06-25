import https from 'httpss';
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

// BIẾN CHO KILL MODE
let currentLongPosition = null;
let currentShortPosition = null;

let positionCheckInterval = null;
let nextScheduledCycleTimeout = null;
let consecutiveApiErrors = 0;
let retryBotTimeout = null;
const logCounts = {};
const LOG_COOLDOWN_MS = 2000;
let currentBotMode = 'kill';
let last30mVolatility = 0;
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
const GRID_RANGE_PERCENT = 0.05; // +-5%
const GRID_STEP_PERCENT = 0.005; // 0.5%
const GRID_INITIAL_TRIGGER_PERCENT = 0.005; // 0.5%
const GRID_ORDER_SIZE_RATIO = 0.20; // 20% vốn ban đầu
const VOLATILITY_CHECK_INTERVAL_MS = 60000; // 60 giây

// --- LỚP LỖI & CÁC HÀM TIỆN ÍCH ---
class CriticalApiError extends Error { constructor(message) { super(message); this.name = 'CriticalApiError'; } }
function addLog(message) { const now = new Date(); const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`; const logEntry = `[${time}] ${message}`; console.log(logEntry); if (LOG_TO_CUSTOM_FILE) { fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {}); } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }
async function makeHttpRequest(method, hostname, path, headers, postData = '') { return new Promise((resolve, reject) => { const options = { hostname, path, method, headers }; const req = https.request(options, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { resolve(data); } else { let errorDetails = { code: res.statusCode, msg: `HTTP Error: ${res.statusCode}` }; try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; } catch (e) {} addLog(`HTTP Request Error: ${errorDetails.msg}`); reject(errorDetails); } }); }); req.on('error', (e) => { addLog(`Network Error: ${e.message}`); reject({ code: 'NETWORK_ERROR', msg: e.message }); }); if (postData) req.write(postData); req.end(); }); }

// --- CÁC HÀM GỌI API BINANCE ---
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) { if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("API/SECRET key missing."); const timestamp = Date.now() + serverTimeOffset; const recvWindow = 5000; let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&'); queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`; const signature = createSignature(queryString, SECRET_KEY); let requestPath, requestBody = ''; const headers = { 'X-MBX-APIKEY': API_KEY }; if (method === 'GET' || method === 'DELETE') { requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`; } else { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; } try { const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody); consecutiveApiErrors = 0; return JSON.parse(rawData); } catch (error) { consecutiveApiErrors++; addLog(`Binance API Error (${method} ${fullEndpointPath}): ${error.msg || error.message}`); if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) { addLog(`Too many consecutive API errors. Stopping bot.`); throw new CriticalApiError("Too many API errors."); } throw error; } }
async function callPublicAPI(fullEndpointPath, params = {}) { const queryString = new URLSearchParams(params).toString(); const fullPathWithQuery = `${fullEndpointPath}?${queryString}`; try { const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, {}); return JSON.parse(rawData); } catch (error) { addLog(`Public API Error: ${error.msg || error.message}`); throw error; } }
async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); } catch (e) { if (e instanceof CriticalApiError) stopBotLogicInternal(); throw e; } }
async function get30mVolatility(symbol) { try { const klines = await callPublicAPI('/fapi/v1/klines', { symbol: symbol, interval: '30m', limit: 2 }); if (klines && klines.length > 0) { const candle = klines[0]; const high = parseFloat(candle[2]), low = parseFloat(candle[3]); if (low > 0) { const volatility = ((high - low) / low) * 100; last30mVolatility = volatility; return volatility; } } return 0; } catch (e) { addLog(`Error getting 30m volatility: ${e.message}`); if (e instanceof CriticalApiError) throw e; return 0; } }
async function getLeverageBracketForSymbol(symbol) { try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); return r.find(i => i.symbol === symbol)?.brackets[0]?.initialLeverage || null; } catch (e) { return null; } }
async function setLeverage(symbol, leverage) { try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); return true; } catch (e) { return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const p = s.filters.find(f => f.filterType === 'PRICE_FILTER'); const l = s.filters.find(f => f.filterType === 'LOT_SIZE'); const m = s.filters.find(f => f.filterType === 'MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, tickSize: parseFloat(p?.tickSize), stepSize: parseFloat(l?.stepSize), minNotional: parseFloat(m?.notional) }; }); return exchangeInfoCache; } catch (e) { throw e; } }
async function getSymbolDetails(symbol) { const f = await getExchangeInfo(); return f?.[symbol] || null; }
async function getCurrentPrice(symbol) { try { return parseFloat((await callPublicAPI('/fapi/v1/ticker/price', { symbol })).price); } catch (e) { return null; } }
async function cancelAllOpenOrdersForSymbol(symbol) { addLog(`Cancelling ALL open orders for ${symbol}...`); try { await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol }); } catch (error) { if (error.code !== -2011) addLog(`Error cancelling orders: ${error.msg}`); } }

// --- LOGIC QUẢN LÝ VỊ THẾ ---
async function closePosition(symbol, reason, positionSide) {
    if (!symbol || !positionSide) return { success: false, pnl: 0 };
    addLog(`Closing ${positionSide} on ${symbol} (Reason: ${reason})...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const pos = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);
        if (pos) {
            const qty = Math.abs(parseFloat(pos.positionAmt));
            if (qty === 0) return { success: false, pnl: 0 };
            const side = (positionSide === 'LONG') ? 'SELL' : 'BUY';
            const res = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side, positionSide, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
            
            // Cập nhật trạng thái bot cho Kill mode
            if(positionSide === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
            if(positionSide === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;

            const realizedPnl = res.fills?.reduce((sum, fill) => sum + parseFloat(fill.realizedPnl), 0) || 0;
            return { success: true, pnl: realizedPnl };
        }
        return { success: false, pnl: 0 };
    } catch (error) {
        addLog(`Error closing ${positionSide}: ${error.msg}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return { success: false, pnl: 0 };
    }
}

async function cleanupAndResetCycle(symbol) {
    addLog(`Cycle for ${symbol} ended. Cleaning up...`);
    if (isGridBotActive) {
        await closeAllGridPositionsAndOrders(false);
    }
    // Reset Kill mode positions
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
                addLog(`Found stale position: ${pos.positionSide} ${pos.positionAmt}. Closing...`);
                await closePosition(pos.symbol, `Stale position cleanup`, pos.positionSide);
                await sleep(500);
            }
        }
    } catch (error) {
        if(error instanceof CriticalApiError) stopBotLogicInternal();
    }
}

// --- LOGIC BOT LƯỚI (SIDEWAYS MODE) ---
async function startSidewaysGridBot() { if (isGridBotActive) return; addLog("[GRID] Activating Sideways Grid Bot mode."); isGridBotActive = true; const triggerPrice = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!triggerPrice) { addLog("[GRID] ERROR: Could not get price to start. Retrying..."); isGridBotActive = false; scheduleNextMainCycle(); return; } gridConfig = { triggerPrice, upperBound: triggerPrice * (1 + GRID_RANGE_PERCENT), lowerBound: triggerPrice * (1 - GRID_RANGE_PERCENT), isInitialOrderPlaced: false, orders: [], activePositions: [], lastVolatilityCheckTime: Date.now() }; addLog(`[GRID] Setup complete. Trigger: ${triggerPrice.toFixed(4)}. Range: ${gridConfig.lowerBound.toFixed(4)} - ${gridConfig.upperBound.toFixed(4)}.`); addLog(`[GRID] Waiting for a ${GRID_INITIAL_TRIGGER_PERCENT*100}% price move to place the first order...`); if (!positionCheckInterval) { positionCheckInterval = setInterval(manageOpenPosition, 5000); } }
async function manageSidewaysGrid() { if (!isGridBotActive || !gridConfig.triggerPrice || currentMarketPrice === null) return; if (!gridConfig.isInitialOrderPlaced) { let side = null; if (currentMarketPrice >= gridConfig.triggerPrice * (1 + GRID_INITIAL_TRIGGER_PERCENT)) side = 'SHORT'; else if (currentMarketPrice <= gridConfig.triggerPrice * (1 - GRID_INITIAL_TRIGGER_PERCENT)) side = 'LONG'; if (side) { addLog(`[GRID] Initial trigger hit. Opening first ${side} position and setting up grid.`); gridConfig.isInitialOrderPlaced = true; await setupGridOrders(side); } return; } if (Date.now() - (gridConfig.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS) { gridConfig.lastVolatilityCheckTime = Date.now(); const vol = await get30mVolatility(TARGET_COIN_SYMBOL); if (vol > 5) { addLog(`[SWITCH] Volatility high (${vol.toFixed(2)}% > 5%). Switching from SIDEWAYS to KILL.`); currentBotMode = 'kill'; await closeAllGridPositionsAndOrders(false); isGridBotActive = false; scheduleNextMainCycle(); return; } } const positionsToClose = gridConfig.activePositions.filter(p => (p.side === 'LONG' && currentMarketPrice <= gridConfig.lowerBound) || (p.side === 'SHORT' && currentMarketPrice >= gridConfig.upperBound)); for (const pos of positionsToClose) await closePositionForGridSL(pos); }
async function setupGridOrders(initialSide) { try { const details = await getSymbolDetails(TARGET_COIN_SYMBOL); const lev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL); if (!details || !lev) throw new Error("Could not get symbol details/leverage."); await setLeverage(TARGET_COIN_SYMBOL, lev); const gridSizeUSD = INITIAL_INVESTMENT_AMOUNT * GRID_ORDER_SIZE_RATIO; let qty = (gridSizeUSD * lev) / gridConfig.triggerPrice; qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision)); if (qty * gridConfig.triggerPrice < details.minNotional) throw new Error(`Grid size is too small.`); await callSignedAPI('/fapi/v1/order', 'POST', { symbol: TARGET_COIN_SYMBOL, side: (initialSide === 'LONG' ? 'BUY' : 'SELL'), positionSide: initialSide, type: 'MARKET', quantity: qty }); addLog(`[GRID] Initial ${initialSide} market order placed.`); gridStats.totalGridsMatched++; await sleep(1500); const totalLines = Math.floor(GRID_RANGE_PERCENT / GRID_STEP_PERCENT); let placed = []; for (let i = 1; i <= totalLines; i++) { const longPrice = parseFloat((gridConfig.triggerPrice * (1 - i * GRID_STEP_PERCENT)).toFixed(details.pricePrecision)); if (longPrice < gridConfig.lowerBound) continue; try { const o = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: TARGET_COIN_SYMBOL, side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: longPrice, quantity: qty, timeInForce: 'GTC' }); placed.push({ orderId: o.orderId, price: longPrice, type: 'LONG_GRID' }); } catch (e) {} const shortPrice = parseFloat((gridConfig.triggerPrice * (1 + i * GRID_STEP_PERCENT)).toFixed(details.pricePrecision)); if (shortPrice > gridConfig.upperBound) continue; try { const o = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: TARGET_COIN_SYMBOL, side: 'SELL', positionSide: 'SHORT', type: 'LIMIT', price: shortPrice, quantity: qty, timeInForce: 'GTC' }); placed.push({ orderId: o.orderId, price: shortPrice, type: 'SHORT_GRID' }); } catch (e) {} } gridConfig.orders = placed; addLog(`[GRID] Placed ${placed.length} limit orders.`); } catch (error) { addLog(`[GRID] FATAL ERROR during setup: ${error.message}. Shutting down grid.`); await closeAllGridPositionsAndOrders(false); } }
async function closePositionForGridSL(pos) { addLog(`[GRID] Position ${pos.side} @${pos.entryPrice} hit SL boundary. Closing...`); const res = await closePosition(TARGET_COIN_SYMBOL, 'Grid SL', pos.side); if (res.success) { gridStats.totalSlHit++; gridStats.totalSlLoss += res.pnl; totalLoss += Math.abs(res.pnl); netPNL += res.pnl; addLog(`[GRID] SL position closed. PNL: ${res.pnl.toFixed(4)}. Total SL Loss: ${gridStats.totalSlLoss.toFixed(4)}`); gridConfig.activePositions = gridConfig.activePositions.filter(p => p.id !== pos.id); if (pos.tpOrderId) try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: TARGET_COIN_SYMBOL, orderId: pos.tpOrderId }); } catch (e) {} } else { addLog(`[GRID] Failed to close SL position.`); } }
async function closeAllGridPositionsAndOrders(andRestart = false) { addLog("[GRID] Closing all grid positions and orders..."); isGridBotActive = false; await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500); await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL); gridConfig = {}; addLog("[GRID] Cleanup complete."); if (botRunning && andRestart) { addLog("[GRID] Restarting grid cycle..."); await startSidewaysGridBot(); } }

// --- LOGIC CHO KILL MODE (ĐÃ KHÔI PHỤC) ---
async function openMarketPosition(symbol, tradeDirection, maxLeverage) {
    addLog(`[KILL] Opening ${tradeDirection} on ${symbol} with ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const details = await getSymbolDetails(symbol);
        if (!details) throw new Error("Failed to get symbol details.");
        
        const price = await getCurrentPrice(symbol);
        if (!price) throw new Error("Failed to get current price.");

        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / price;
        quantity = parseFloat((Math.floor(quantity / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));

        if (quantity * price < details.minNotional) {
             throw new Error("Calculated order size is below minimum notional.");
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side: orderSide, positionSide: tradeDirection,
            type: 'MARKET', quantity,
        });

        // Chờ và xác nhận vị thế
        await sleep(2000);
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (!openPos) throw new Error("Position not confirmed on exchange after opening.");

        const actualEntryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`[KILL] Opened ${tradeDirection} | Qty: ${actualQuantity} | Entry: ${actualEntryPrice}`);

        return {
            symbol, quantity: actualQuantity, initialQuantity: actualQuantity, 
            entryPrice: actualEntryPrice, initialMargin: INITIAL_INVESTMENT_AMOUNT,
            side: tradeDirection, maxLeverageUsed: maxLeverage,
            pricePrecision: details.pricePrecision, quantityPrecision: details.quantityPrecision,
            // Thêm các thuộc tính khác của kill mode nếu cần
            currentTPId: null, currentSLId: null, unrealizedPnl: 0,
        };
    } catch (error) {
        addLog(`[KILL] Error opening ${tradeDirection}: ${error.message}`);
        if (error instanceof CriticalApiError) stopBotLogicInternal();
        return null;
    }
}

async function setTPAndSLForPosition(position) {
    if (!position || position.quantity <= 0) return false;
    const { symbol, side, entryPrice, quantity, pricePrecision, maxLeverageUsed, initialMargin } = position;
    addLog(`[KILL] Setting TP/SL for ${side} at entry ${entryPrice}...`);
    try {
        // Đây là logic TP/SL đơn giản, bạn có thể thay thế bằng logic phức tạp của mình
        const tpPercent = maxLeverageUsed > 50 ? 0.05 : 0.035; // 5% or 3.5% PNL
        const slPercent = maxLeverageUsed > 50 ? 0.03 : 0.02; // 3% or 2% PNL
        
        const tpPriceChange = (initialMargin * tpPercent) / quantity;
        const slPriceChange = (initialMargin * slPercent) / quantity;

        const tpPrice = parseFloat((side === 'LONG' ? entryPrice + tpPriceChange : entryPrice - tpPriceChange).toFixed(pricePrecision));
        const slPrice = parseFloat((side === 'LONG' ? entryPrice - slPriceChange : entryPrice + slPriceChange).toFixed(pricePrecision));
        
        const orderSide = (side === 'LONG') ? 'SELL' : 'BUY';
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, quantity });
        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: side, type: 'STOP_MARKET', stopPrice: slPrice, quantity });

        position.currentTPId = tpOrder.orderId;
        position.currentSLId = slOrder.orderId;
        addLog(`[KILL] ${side} TP/SL set: TP at ${tpPrice}, SL at ${slPrice}`);
        return true;
    } catch (error) {
        addLog(`[KILL] Error setting TP/SL for ${side}: ${error.message}`);
        return false;
    }
}


// --- LOGIC CHÍNH & QUẢN LÝ BOT ---
async function runTradingLogic() {
    if (!botRunning || isGridBotActive || currentLongPosition || currentShortPosition) return;
    addLog('Starting new trading cycle...');
    try {
        const vol = await get30mVolatility(TARGET_COIN_SYMBOL);
        currentBotMode = (vol <= 3) ? 'sideways' : 'kill';
        addLog(`Mode selected: ${currentBotMode.toUpperCase()} (30m Vol: ${vol.toFixed(2)}%)`);

        if (currentBotMode === 'sideways') {
            await startSidewaysGridBot();
            return;
        } 
        
        if (currentBotMode === 'kill') {
            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) { scheduleNextMainCycle(); return; }
            
            await setLeverage(TARGET_COIN_SYMBOL, maxLeverage);
            
            currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLeverage);
            await sleep(500);
            currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLeverage);

            if(!currentLongPosition || !currentShortPosition){
                addLog("[KILL] Failed to open one of the positions. Cleaning up...");
                if(currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, 'Kill setup fail', 'LONG');
                if(currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, 'Kill setup fail', 'SHORT');
                cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                return;
            }

            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            await sleep(500);

            await setTPAndSLForPosition(currentLongPosition);
            await setTPAndSLForPosition(currentShortPosition);

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
    if (isGridBotActive) {
        await manageSidewaysGrid();
        return;
    }
    
    if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            
            const longPosOnExchange = positions.find(p => p.positionSide === 'LONG');
            const shortPosOnExchange = positions.find(p => p.positionSide === 'SHORT');
            
            if (currentLongPosition) {
                if (longPosOnExchange && Math.abs(parseFloat(longPosOnExchange.positionAmt)) > 0) {
                    currentLongPosition.unrealizedPnl = parseFloat(longPosOnExchange.unRealizedProfit);
                } else {
                    currentLongPosition = null; // Position closed
                }
            }
             if (currentShortPosition) {
                if (shortPosOnExchange && Math.abs(parseFloat(shortPosOnExchange.positionAmt)) > 0) {
                    currentShortPosition.unrealizedPnl = parseFloat(shortPosOnExchange.unRealizedProfit);
                } else {
                    currentShortPosition = null; // Position closed
                }
            }
            
            // Nếu cả 2 lệnh đã đóng, reset chu kỳ
            if (!currentLongPosition && !currentShortPosition) {
                addLog("[KILL] Both positions are closed. Resetting cycle.");
                cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            }
            // Bạn có thể thêm logic quản lý vị thế thắng/thua của kill mode vào đây
            
        } catch(error) {
            if(error instanceof CriticalApiError) stopBotLogicInternal();
        }
    }
};

async function scheduleNextMainCycle() {
    if (!botRunning || isGridBotActive || currentLongPosition || currentShortPosition) return;
    clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

async function processTradeResult(orderInfo) {
    const { s: symbol, i: orderId, X: orderStatus, S: side, ps: positionSide, z: filledQtyStr, rp: realizedPnlStr } = orderInfo;
    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') return;
    
    const filledQty = parseFloat(filledQtyStr);
    const realizedPnl = parseFloat(realizedPnlStr);

    // Xử lý cho Grid Mode
    if (isGridBotActive && gridConfig.orders && filledQty > 0) {
        // Logic khớp lệnh lưới
        const matchedGridOrder = gridConfig.orders.find(o => o.orderId === orderId);
        if (matchedGridOrder) {
            gridStats.totalGridsMatched++;
            addLog(`[GRID] Matched: ${matchedGridOrder.type} ${side} ${filledQty} @ ${orderInfo.L}`);
            gridConfig.orders = gridConfig.orders.filter(o => o.orderId !== orderId);
            const pos = { id: orderId, side: positionSide, entryPrice: parseFloat(orderInfo.L), quantity: filledQty, tpOrderId: null };
            gridConfig.activePositions.push(pos);
            const details = await getSymbolDetails(symbol);
            const tpPrice = parseFloat((positionSide === 'LONG' ? pos.entryPrice * (1 + GRID_STEP_PERCENT) : pos.entryPrice * (1 - GRID_STEP_PERCENT)).toFixed(details.pricePrecision));
            try {
                const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (positionSide === 'LONG' ? 'SELL' : 'BUY'), positionSide, type: 'LIMIT', price: tpPrice, quantity: filledQty, timeInForce: 'GTC' });
                pos.tpOrderId = tpOrder.orderId;
                addLog(`[GRID] TP set for new position at ${tpPrice}`);
            } catch (e) {
                addLog(`[GRID] Error setting TP: ${e.message}`);
            }
            return;
        }
        // Logic khớp lệnh TP của lưới
        const matchedTpOrder = gridConfig.activePositions.find(p => p.tpOrderId === orderId);
        if (matchedTpOrder) {
            gridStats.totalTpHit++;
            addLog(`[GRID] TP HIT for ${matchedTpOrder.side}! PNL: ${realizedPnl}`);
            if (realizedPnl !== 0) {
                if (realizedPnl > 0) totalProfit += realizedPnl;
                else totalLoss += Math.abs(realizedPnl);
                netPNL = totalProfit - totalLoss;
            }
            gridConfig.activePositions = gridConfig.activePositions.filter(p => p.tpOrderId !== orderId);
            const details = await getSymbolDetails(symbol);
            try {
                const newGridOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: (matchedTpOrder.side === 'LONG' ? 'BUY' : 'SELL'), positionSide: matchedTpOrder.side, type: 'LIMIT', price: matchedTpOrder.entryPrice, quantity: matchedTpOrder.quantity, timeInForce: 'GTC' });
                gridConfig.orders.push({ orderId: newGridOrder.orderId, price: matchedTpOrder.entryPrice, type: `${matchedTpOrder.side}_GRID` });
                addLog(`[GRID] Re-placing grid order at ${matchedTpOrder.entryPrice}.`);
            } catch(e) {
                addLog(`[GRID] Error re-placing grid order: ${e.message}`);
            }
            return;
        }
    }

    // Xử lý cho Kill Mode
    if (currentBotMode === 'kill' && realizedPnl !== 0) {
        addLog(`[KILL] Trade executed for ${positionSide}. PNL: ${realizedPnl.toFixed(4)}`);
        if (realizedPnl > 0) totalProfit += realizedPnl;
        else totalLoss += Math.abs(realizedPnl);
        netPNL = totalProfit - totalLoss;

        // Kiểm tra xem lệnh đóng có phải do TP/SL của bot hay không để reset
        const isLongClosure = currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId);
        const isShortClosure = currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId);

        if(isLongClosure || isShortClosure) {
             addLog(`[KILL] A primary position was closed. Cleaning up the other side and resetting.`);
             cleanupAndResetCycle(TARGET_COIN_SYMBOL);
        }
    }
}
async function startBotLogicInternal() { if (botRunning) return 'Bot is already running.'; if (!API_KEY || !SECRET_KEY) return 'Error: API/SECRET key missing.'; if (retryBotTimeout) clearTimeout(retryBotTimeout); addLog('--- Starting Bot ---'); try { await syncServerTime(); await getExchangeInfo(); await closeAllGridPositionsAndOrders(false); await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL); listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); setupMarketDataStream(TARGET_COIN_SYMBOL); botRunning = true; botStartTime = new Date(); totalProfit=0; totalLoss=0; netPNL=0; gridStats = { totalGridsMatched: 0, totalTpHit: 0, totalSlHit: 0, totalSlLoss: 0 }; currentLongPosition = null; currentShortPosition = null; isGridBotActive = false; addLog(`--- Bot Started: ${new Date().toLocaleString()} | Coin: ${TARGET_COIN_SYMBOL} | Investment: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`); scheduleNextMainCycle(); return 'Bot started successfully.'; } catch (error) { stopBotLogicInternal(); if (error instanceof CriticalApiError) retryBotTimeout = setTimeout(startBotLogicInternal, ERROR_RETRY_DELAY_MS); return `Error starting bot: ${error.message}`; } }
async function stopBotLogicInternal() { if (!botRunning) return 'Bot is not running.'; addLog('--- Stopping Bot ---'); botRunning = false; clearTimeout(nextScheduledCycleTimeout); if (positionCheckInterval) clearInterval(positionCheckInterval); positionCheckInterval = null; await closeAllGridPositionsAndOrders(false); await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL); currentLongPosition=null; currentShortPosition=null; isGridBotActive=false; if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; } if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.close(); userDataWs = null; } if (retryBotTimeout) clearTimeout(retryBotTimeout); addLog('--- Bot Stopped ---'); return 'Bot stopped.'; }

// --- WEBSOCKETS & WEB SERVER ---
function setupMarketDataStream(symbol) { if (marketWs) marketWs.close(); marketWs = new WebSocket(`${WS_BASE_URL}/ws/${symbol.toLowerCase()}@markPrice@1s`); marketWs.onopen = () => addLog("Market Stream Connected."); marketWs.onmessage = (e) => { try { currentMarketPrice = parseFloat(JSON.parse(e.data).p); } catch {} }; marketWs.onclose = () => { if (botRunning) setTimeout(() => setupMarketDataStream(symbol), 5000); }; marketWs.onerror = (err) => addLog(`Market Stream Error: ${err.message}`); }
function setupUserDataStream(key) { if (userDataWs) userDataWs.close(); userDataWs = new WebSocket(`${WS_BASE_URL}/ws/${key}`); userDataWs.onopen = () => { addLog("User Data Stream Connected."); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(keepAliveListenKey, 30 * 60 * 1000); }; userDataWs.onmessage = async (e) => { try { const d = JSON.parse(e.data); if (d.e === 'ORDER_TRADE_UPDATE') await processTradeResult(d.o); } catch {} }; userDataWs.onclose = () => { if (botRunning) setTimeout(async () => { listenKey = await getListenKey(); if (listenKey) setupUserDataStream(listenKey); }, 5000); }; userDataWs.onerror = (err) => addLog(`User Stream Error: ${err.message}`); }
async function keepAliveListenKey() { if (listenKey) try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey }); } catch (e) {} }
const app = express(); app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/logs', (req, res) => fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => res.send(data || '')));
app.get('/api/status', (req, res) => { let statusMsg = `BOT: ${botRunning ? 'RUNNING' : 'STOPPED'}`; if (botRunning) { statusMsg += ` | Uptime: ${Math.floor((Date.now() - (botStartTime?.getTime() || Date.now())) / 60000)}m`; statusMsg += ` | Mode: ${currentBotMode.toUpperCase()}`; if (currentBotMode === 'sideways') { statusMsg += ` (Grid: ${isGridBotActive ? 'ACTIVE' : 'INACTIVE'})`; let posText = " | Positions: --"; if (isGridBotActive && gridConfig.activePositions?.length > 0) { const longCount = gridConfig.activePositions.filter(p=>p.side === 'LONG').length; const shortCount = gridConfig.activePositions.filter(p=>p.side === 'SHORT').length; posText = ` | Grid Pos: L(${longCount}), S(${shortCount})`; } statusMsg += posText; } else { statusMsg += ` (Vol:${last30mVolatility.toFixed(1)}%)`; let posText = " | Positions: --"; if (currentLongPosition || currentShortPosition) { posText = ` | Kill Pos: ${currentLongPosition ? 'L' : ''}${currentShortPosition ? 'S' : ''}`; } statusMsg += posText; } } res.send(statusMsg); });
app.post('/api/configure', (req, res) => { const { symbol, initialAmount } = req.body; let changed = false; if (symbol && symbol.trim().toUpperCase() !== TARGET_COIN_SYMBOL) { TARGET_COIN_SYMBOL = symbol.trim().toUpperCase(); changed = true; } if (initialAmount && parseFloat(initialAmount) > 0 && parseFloat(initialAmount) !== INITIAL_INVESTMENT_AMOUNT) { INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount); changed = true; } if (changed && botRunning) { stopBotLogicInternal(); addLog("Config changed. Bot stopped. Please restart."); } res.json({ success: changed, message: changed ? 'Config updated. Restart bot.' : 'No changes.' }); });
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', (req, res) => res.send(await stopBotLogicInternal()));
app.get('/api/bot_stats', (req, res) => {
    let killModePositions = [];
    if (currentLongPosition) killModePositions.push({ side: 'LONG', entryPrice: currentLongPosition.entryPrice, quantity: currentLongPosition.quantity, unrealizedPnl: currentLongPosition.unrealizedPnl });
    if (currentShortPosition) killModePositions.push({ side: 'SHORT', entryPrice: currentShortPosition.entryPrice, quantity: currentShortPosition.quantity, unrealizedPnl: currentShortPosition.unrealizedPnl });

    let sidewaysModePositions = [];
    let unrealizedGridPnl = 0;
    if (isGridBotActive && gridConfig.activePositions) {
        sidewaysModePositions = gridConfig.activePositions.map(pos => {
            let pnl = 0;
            if (currentMarketPrice && pos.entryPrice && pos.quantity) {
                const pnlPerUnit = currentMarketPrice - pos.entryPrice;
                pnl = (pos.side === 'LONG' ? pnlPerUnit : -pnlPerUnit) * pos.quantity;
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
            killModePositions,
            sidewaysModePositions,
            gridStats,
            unrealizedGridPnl,
        }
    });
});
app.listen(WEB_SERVER_PORT, () => addLog(`Web server running at http://localhost:${WEB_SERVER_PORT}`));
