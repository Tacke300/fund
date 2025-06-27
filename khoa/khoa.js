
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { URL } from 'url';

import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VPS1_DATA_URL = 'http://34.142.248.96:9000/';
const MIN_CANDLES_FOR_SELECTION = 55;
const VOLATILITY_SWITCH_THRESHOLD_PERCENT = 5.0;
const MIN_VOLATILITY_DIFFERENCE_TO_SWITCH = 3.0;
const OVERALL_VOLATILITY_THRESHOLD_VPS1 = 5.0;
const MIN_LEVERAGE_TO_TRADE = 50;
const PARTIAL_CLOSE_INDEX_5 = 4;
const PARTIAL_CLOSE_INDEX_8 = 7;
const KILL_MODE_UNDER_MOC5_SWITCH_VOL_THRESHOLD = 10.0;

const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

const WEB_SERVER_PORT = 6789;
const THIS_BOT_PM2_NAME = 'khoa';
const CUSTOM_LOG_FILE = path.join(__dirname, `pm2_${THIS_BOT_PM2_NAME}.log`);
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
const VOLATILITY_CHECK_INTERVAL_MS = 1 * 60 * 1000;
const MODE_SWITCH_DELAY_MS = 10000;
const COIN_SWITCH_DELAY_MS = 10000;

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
let INITIAL_INVESTMENT_AMOUNT = 1.20;
let TARGET_COIN_SYMBOL = null;
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;
let cumulativeRealizedPnlSinceStart = 0;
let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null;
let consecutiveApiErrors = 0;
let vps1DataCache = [];
let sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForSwitch: false, switchDelayTimeout: null };
let lastCoinSwitchCheckTime = 0;
let isOpeningInitialPair = false;
let overallTakeProfit = 0;
let overallStopLoss = -4;
let lastHourVolatility = 0;

class CriticalApiError extends Error { constructor(message) { super(message); this.name = 'CriticalApiError'; } }

function addLog(message) {
    const now = new Date(); const offset = 7*60*60*1000; const localTime = new Date(now.getTime() + offset);
    const time = `${localTime.toLocaleDateString('en-GB')} ${localTime.toLocaleTimeString('en-US', { hour12: false })}.${String(localTime.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`; const messageHash = crypto.createHash('md5').update(message).digest('hex');
    if (logCounts[messageHash]) {
        logCounts[messageHash].count++; const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        if ((localTime.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) return;
        if (logCounts[messageHash].count > 1) { const repeatedMessage = `[${time}] (Lặp lại x${logCounts[messageHash].count -1} lần trước đó) ${message}`; console.log(repeatedMessage); if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, repeatedMessage + '\n', (err) => { if (err) console.error("Lỗi ghi log:", err);}); }
        else { console.log(logEntry); if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {if (err) console.error("Lỗi ghi log:", err);}); }
        logCounts[messageHash] = { count: 1, lastLoggedTime: localTime };
    } else { console.log(logEntry); if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {if (err) console.error("Lỗi ghi log:", err);}); logCounts[messageHash] = { count: 1, lastLoggedTime: localTime }; }
}
function formatTimeUTC7(dateObject) { if (!dateObject) return 'N/A'; const formatter = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh' }); return formatter.format(dateObject); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }

async function makeHttpRequest(method, urlString, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = { hostname: parsedUrl.hostname, port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80), path: parsedUrl.pathname + parsedUrl.search, method: method, headers: {...headers, 'User-Agent': 'NodeJS-Client/1.0-VPS2-Bot-Fuller-v3'}, timeout: 20000 };
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => { let data = ''; res.on('data', (chunk) => data += chunk); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else { const errorMsg = `HTTP Lỗi: ${res.statusCode} ${res.statusMessage} khi gọi ${urlString}`; let errorDetails = { code: res.statusCode, msg: errorMsg, url: urlString, responseBody: data.substring(0, 500) }; try { const parsedData = JSON.parse(data); errorDetails = { ...errorDetails, ...parsedData }; } catch (e) {  } reject(errorDetails); }}); });
        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: `${e.message} (khi gọi ${urlString})`, url: urlString }));
        req.on('timeout', () => { req.destroy(); reject({ code: 'TIMEOUT_ERROR', msg: `Request timed out sau ${options.timeout/1000}s (khi gọi ${urlString})`, url: urlString }); });
        if (postData && (method === 'POST' || method === 'PUT')) req.write(postData); req.end();
    });
}
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Lỗi: Thiếu API_KEY/SECRET_KEY."); const timestamp = Date.now() + serverTimeOffset; const recvWindow = 5000;
    let queryString = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&'); queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = createSignature(queryString, SECRET_KEY); let requestPath; let requestBody = ''; const headers = { 'X-MBX-APIKEY': API_KEY };
    if (method === 'GET' || method === 'DELETE') requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
    else if (method === 'POST' || method === 'PUT') { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    else throw new Error(`Phương thức API không hỗ trợ: ${method}`);
    const fullUrlToCall = `https://${BASE_HOST}${requestPath}`;
    try { const rawData = await makeHttpRequest(method, fullUrlToCall, headers, requestBody); consecutiveApiErrors = 0; return JSON.parse(rawData); }
    catch (error) { consecutiveApiErrors++; addLog(`Lỗi API Binance (${method} ${fullUrlToCall}): ${error.code||'UNK'} - ${error.msg||error.message}. Body: ${error.responseBody||'N/A'}`); if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) addLog("  -> RATE LIMIT."); if (error.code === -1021 && error.msg && error.msg.toLowerCase().includes("timestamp")) await syncServerTime(); if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Quá nhiều lỗi API Binance."); throw error; }
}
async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString(); const fullPathWithQuery = `${fullEndpointPath}${queryString ? '?' + queryString : ''}`; const fullUrlToCall = `https://${BASE_HOST}${fullPathWithQuery}`;
    try { const rawData = await makeHttpRequest('GET', fullUrlToCall, {}); consecutiveApiErrors = 0; return JSON.parse(rawData); }
    catch (error) { consecutiveApiErrors++; addLog(`Lỗi API Public Binance (${fullUrlToCall}): ${error.code||'UNK'} - ${error.msg||error.message}. Body: ${error.responseBody||'N/A'}`); if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) addLog("  -> RATE LIMIT."); if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Quá nhiều lỗi API Public Binance."); throw error; }
}
async function fetchAndCacheTopCoinsFromVPS1(silent = false) {
    const fullUrl = VPS1_DATA_URL; if (!silent) addLog(`Lấy dữ liệu VPS1 & cache: ${fullUrl}`); let rawDataForDebug = '';
    try { const rawData = await makeHttpRequest('GET', fullUrl); rawDataForDebug = rawData; const response = JSON.parse(rawData);
        if (response && response.status && Array.isArray(response.data)) {
            if (response.status === "running_data_available") { const filtered = response.data.filter(c => c.symbol && typeof c.changePercent === 'number' && c.candles >= MIN_CANDLES_FOR_SELECTION); vps1DataCache = [...filtered]; if (!silent) addLog(`VPS1 data cached. ${filtered.length} coins (status: ${response.status}).`); return [...filtered]; }
            else if (response.status === "error_binance_symbols" || response.status.startsWith("error")) { if (!silent) addLog(`VPS1 error (status: ${response.status}): ${response.message||'Lỗi VPS1'}. Dùng cache cũ (${vps1DataCache.length} coins).`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
            else { if (!silent) addLog(`VPS1 preparing (status: ${response.status}): ${response.message||'Chưa có message'}. Dùng cache cũ (${vps1DataCache.length} coins).`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
        } else { if (!silent) addLog(`Lỗi định dạng VPS1. Status: ${response?.status}. Dùng cache cũ (${vps1DataCache.length} coins). Raw: ${rawData.substring(0,200)}`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
    } catch (error) { let errMsg = `Lỗi lấy/phân tích VPS1 (${fullUrl}): ${error.code||'ERR'} - ${error.msg||error.message}.`; if(error.responseBody) errMsg+=` Body: ${error.responseBody.substring(0,100)}`; else if(error instanceof SyntaxError && error.message.includes("JSON")) errMsg+=` Lỗi parse JSON. Raw: ${rawDataForDebug.substring(0,100)}`; if (!silent) addLog(errMsg + `. Dùng cache cũ (${vps1DataCache.length} coins).`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
}
function getCurrentCoinVPS1Data(symbol) { if (!symbol || !vps1DataCache || vps1DataCache.length === 0) return null; return vps1DataCache.find(c => c.symbol === symbol); }
async function getLeverageBracketForSymbol(symbol) { if(!symbol) return 20; try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const b = r.find(i => i.symbol === symbol)?.brackets[0]; return b ? parseInt(b.initialLeverage) : null; } catch (e) { addLog(`Lỗi lấy lev bracket ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi lấy lev bracket ${symbol}`); return null; } }
async function checkExistingPosition(symbol) { if (!symbol) return false; try { const pos = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }); return pos.some(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0); } catch (e) { if (e.code === -4003 && e.msg?.toLowerCase().includes("invalid symbol")) return false; addLog(`Lỗi check vị thế ${symbol}: ${e.msg||e.message}. Coi như có.`); return true; } }

async function selectTargetCoin(isInitialSelection = false) {
    addLog("Bắt đầu quy trình chọn coin mới...");
    const vps1Coins = await fetchAndCacheTopCoinsFromVPS1();
    if (!vps1Coins || vps1Coins.length === 0) {
        addLog("Không có dữ liệu coin từ VPS1/cache.");
        return null;
    }
    try {
        const allPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const existingPositionsSet = new Set(allPositions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol));

        if (TARGET_COIN_SYMBOL && (currentLongPosition || currentShortPosition || sidewaysGrid.isActive)) {
             existingPositionsSet.add(TARGET_COIN_SYMBOL);
        }

        addLog(`VPS1 cung cấp ${vps1Coins.length} coin. Tìm coin biến động cao nhất chưa có vị thế...`);

        for (const coin of vps1Coins) {
            if (!existingPositionsSet.has(coin.symbol)) {
                addLog(`ĐÃ CHỌN: ${coin.symbol} (Vol: ${coin.changePercent.toFixed(2)}%) vì là coin biến động cao nhất và chưa có vị thế.`);
                return coin.symbol;
            }
        }

        addLog("Tất cả coin biến động cao từ VPS1 đều đã có vị thế. Không chọn coin mới.");
        return null;

    } catch (error) {
        addLog(`Lỗi khi lấy danh sách vị thế để chọn coin: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal("Lỗi API khi lấy vị thế");
        return null;
    }
}

async function getHourlyVolatility(symbol) { try { const klines = await callPublicAPI('/fapi/v1/klines', { symbol: symbol, interval: '1h', limit: 2 }); if (klines && klines.length > 0) { const lastCompletedCandle = klines[0]; const high = parseFloat(lastCompletedCandle[2]); const low = parseFloat(lastCompletedCandle[3]); if (low > 0) { const volatility = ((high - low) / low) * 100; lastHourVolatility = volatility; return volatility; } } return 0; } catch (e) { addLog(`Lỗi khi lấy dữ liệu biến động 1h: ${e.message}`); if (e instanceof CriticalApiError && botRunning) throw e; return 0; } }
async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`Đồng bộ thời gian server: Offset ${serverTimeOffset}ms`); } catch (e) { addLog(`Lỗi đồng bộ thời gian: ${e.msg || e.message}`); if (e instanceof CriticalApiError) {if(botRunning) await stopBotLogicInternal("Lỗi đồng bộ thời gian"); throw e;} }}
async function setLeverage(symbol, leverage) { if(!symbol) return false; try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đặt đòn bẩy ${symbol}`); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const pF = s.filters.find(f=>f.filterType==='PRICE_FILTER'); const lF = s.filters.find(f=>f.filterType==='LOT_SIZE'); const mF = s.filters.find(f=>f.filterType==='MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision:s.pricePrecision, quantityPrecision:s.quantityPrecision, tickSize:parseFloat(pF?.tickSize || 1e-8), stepSize:parseFloat(lF?.stepSize || 1e-8), minNotional:parseFloat(mF?.notional || 0.1) }; }); addLog("Lấy Exchange Info."); return exchangeInfoCache; } catch (e) { addLog(`Lỗi lấy Exchange Info: ${e.msg||e.message}`); if (e instanceof CriticalApiError) {if(botRunning) await stopBotLogicInternal("Lỗi lấy Exchange Info"); throw e;} throw e; } }
async function getSymbolDetails(symbol) { if(!symbol) return null; const info = await getExchangeInfo(); if (!info) return null; const details = info[symbol]; if (!details) { addLog(`Không tìm thấy chi tiết ${symbol}. Thử làm mới.`); exchangeInfoCache=null; const fresh=await getExchangeInfo(); return fresh?.[symbol]||null;} return details;}
async function getCurrentPrice(symbol) { if(!symbol) return null; try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Lỗi lấy giá ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi lấy giá ${symbol}`); return null; } }

async function cancelAllOpenOrdersForSymbol(symbol) {
    if (!symbol) return true; addLog(`Hủy TẤT CẢ lệnh chờ ${symbol}...`);
    try { const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol }); if (!openOrders || openOrders.length === 0) { addLog(`Không lệnh chờ ${symbol}.`); return true; } addLog(`Tìm thấy ${openOrders.length} lệnh chờ ${symbol}. Đang hủy...`);
        for (const order of openOrders) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol, orderId:order.orderId, origClientOrderId:order.clientOrderId }); addLog(`  Đã hủy lệnh ${order.orderId} (ClientID: ${order.clientOrderId}).`); await sleep(100); } catch (innerErr) { if (innerErr.code!==-2011) addLog(`  Lỗi hủy lệnh ${order.orderId}: ${innerErr.msg||innerErr.message}`); else addLog(`  Lệnh ${order.orderId} có thể đã xử lý.`); if (innerErr instanceof CriticalApiError && botRunning) {await stopBotLogicInternal(`Lỗi hủy lệnh ${order.orderId}`); return false;} }} addLog(`Hoàn tất hủy lệnh chờ ${symbol}.`); return true;
    } catch (e) { if (e.code!==-2011) addLog(`Lỗi lấy DS lệnh chờ để hủy ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError && botRunning) {await stopBotLogicInternal(`Lỗi lấy DS lệnh chờ ${symbol}`); return false;} return false; }
}
async function closePosition(symbol, reason, positionSideToClose) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSideToClose || isProcessingTrade) {
        if(isProcessingTrade) addLog(`closePosition(${symbol}) bỏ qua do isProcessingTrade.`);
        return false;
    }
    isProcessingTrade = true; addLog(`Đóng ${positionSideToClose} ${symbol} (Lý do: ${reason})...`);
    let success = false;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === positionSideToClose && parseFloat(p.positionAmt) !== 0);
        if (posOnEx) {
            const qty = Math.abs(parseFloat(posOnEx.positionAmt));
            if (qty === 0) {
                success = false;
            } else {
                const sideOrder = (positionSideToClose === 'LONG') ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: sideOrder, positionSide: positionSideToClose, type: 'MARKET', quantity: qty, newClientOrderId: `CLOSE-${positionSideToClose[0]}-${Date.now().toString().slice(-10)}` });
                addLog(`Đã gửi MARKET đóng ${qty} ${positionSideToClose} ${symbol}.`);
                if (positionSideToClose === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
                else if (positionSideToClose === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;
                success = true;
            }
        } else {
            addLog(`Không tìm thấy vị thế ${positionSideToClose} ${symbol}.`);
            success = false;
        }
    } catch (err) {
        addLog(`Lỗi đóng ${positionSideToClose} ${symbol}: ${err.msg||err.message}`);
        if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đóng ${positionSideToClose} ${symbol}`);
        success = false;
    } finally {
        isProcessingTrade = false;
        return success;
    }
}
async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    addLog(`[${currentBotMode.toUpperCase()}] Mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try { const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`); if (!await setLeverage(symbol, maxLeverage)) throw new Error(`Lỗi đặt đòn bẩy.`); await sleep(200);
        const priceToUseForCalc = entryPriceOverride || await getCurrentPrice(symbol); if (!priceToUseForCalc) throw new Error(`Lỗi lấy giá hiện tại/giá ghi đè.`);
        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceToUseForCalc; quantity = parseFloat((Math.floor(quantity / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (quantity * priceToUseForCalc < details.minNotional) throw new Error("Giá trị lệnh quá nhỏ so với sàn.");
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity});
        let openPos = null;
        for(let i = 0; i < 15; i++) {
            await sleep(400);
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) >= quantity * 0.95);
            if (openPos && Math.abs(parseFloat(openPos.positionAmt)) > 0) break;
        }
        if (!openPos || Math.abs(parseFloat(openPos.positionAmt)) === 0) throw new Error("Vị thế MARKET chưa xác nhận trên sàn sau nhiều lần thử.");
        const actualEntryPrice = parseFloat(openPos.entryPrice); const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        addLog(`[${currentBotMode.toUpperCase()}] Đã MỞ ${tradeDirection} | KL: ${actualQuantity.toFixed(details.quantityPrecision)} | Giá vào thực tế: ${actualEntryPrice.toFixed(details.pricePrecision)}`);
        return {symbol,quantity:actualQuantity,initialQuantity:actualQuantity,entryPrice:actualEntryPrice,initialMargin:INITIAL_INVESTMENT_AMOUNT,side:tradeDirection,maxLeverageUsed:maxLeverage,pricePrecision:details.pricePrecision,quantityPrecision:details.quantityPrecision,closedLossAmount:0,nextPartialCloseLossIndex:0,hasAdjustedSLToSpecificLevel:{},hasClosedAllLossPositionAtLastLevel:false,pairEntryPrice:priceToUseForCalc,currentTPId:null,currentSLId:null,unrealizedPnl:0,currentPrice:actualEntryPrice, lastPnlBaseResetTime: Date.now()};
    } catch (err) { addLog(`[${currentBotMode.toUpperCase()}] Lỗi mở ${tradeDirection} ${symbol}: ${err.msg||err.message}`); if(err instanceof CriticalApiError && botRunning)await stopBotLogicInternal(`Lỗi mở ${tradeDirection} ${symbol}`); return null; }
}

async function setTPAndSLForPosition(position, isFullResetEvent = false) {
    if (!position || position.quantity <= 0 || !position.symbol) return false;
    const symbolDetails = await getSymbolDetails(position.symbol);
    if (!symbolDetails) { addLog(`Không có symbolDetails cho ${position.symbol} để đặt TP/SL`); return false; }

    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity } = position;

    if (currentBotMode === 'kill') {
        addLog(`[KILL] Đặt/Reset TP/SL cho ${side} (Entry: ${entryPrice.toFixed(pricePrecision)}, KL: ${quantity.toFixed(position.quantityPrecision)})...`);
        try {
            let TAKE_PROFIT_MULTIPLIER, STOP_LOSS_MULTIPLIER, partialCloseLossSteps = [];
            if (maxLeverageUsed >= 75) { TAKE_PROFIT_MULTIPLIER = 10; STOP_LOSS_MULTIPLIER = 6; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); }
            else if (maxLeverageUsed >= MIN_LEVERAGE_TO_TRADE) { TAKE_PROFIT_MULTIPLIER = 5; STOP_LOSS_MULTIPLIER = 3; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); }
            else { TAKE_PROFIT_MULTIPLIER = 3.5; STOP_LOSS_MULTIPLIER = 2; for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); }

            const targetPnlForTP_USDT = initialMargin * TAKE_PROFIT_MULTIPLIER;
            const targetPnlForSL_USDT = -(initialMargin * STOP_LOSS_MULTIPLIER);

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
            addLog(`  ${side} ${symbol}: TP ${tpPrice.toFixed(pricePrecision)}, SL ${slPrice.toFixed(pricePrecision)} cho KL ${quantity.toFixed(symbolDetails.quantityPrecision)}`);

            if(position.currentTPId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol,orderId:position.currentTPId});position.currentTPId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy TP cũ ${position.currentTPId}: ${e.msg}`);}
            if(position.currentSLId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol,orderId:position.currentSLId});position.currentSLId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy SL cũ ${position.currentSLId}: ${e.msg}`);}
            await sleep(300);

            const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: orderSidePlace, positionSide: side, type: 'STOP_MARKET',
                stopPrice: slPrice, quantity, timeInForce: 'GTC', closePosition: 'true', newClientOrderId: `SL-${side}-${Date.now()}`
            });
            const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: orderSidePlace, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                stopPrice: tpPrice, quantity, timeInForce: 'GTC', closePosition: 'true', newClientOrderId: `TP-${side}-${Date.now()}`
            });

            position.currentTPId = tpOrder.orderId;
            position.currentSLId = slOrder.orderId;
            addLog(`  Đã đặt TP ID: ${tpOrder.orderId}, SL ID: ${slOrder.orderId}.`);

            if (!position.partialCloseLossLevels || position.partialCloseLossLevels.length === 0 || isFullResetEvent) position.partialCloseLossLevels = partialCloseLossSteps;
            if (isFullResetEvent) {
                position.nextPartialCloseLossIndex = 0;
                position.hasAdjustedSLToSpecificLevel = {};
                position.hasClosedAllLossPositionAtLastLevel = false;
                position.lastPnlBaseResetTime = Date.now();
            }
            return true;
        } catch (error) {
            addLog(`[KILL] Lỗi đặt TP/SL cho ${side}: ${error.msg || error.message}.`);
             if(error.code===-2021||(error.msg&&error.msg.includes("immediately trigger")))addLog("   Lỗi -2021: Giá stopPrice không hợp lệ.");
            if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đặt TP/SL ${side} ${symbol}`);
            return false;
        }
    } else if (currentBotMode === 'sideways') {
        addLog(`[LƯỚI] TP/SL cho lệnh lưới sẽ được đặt trong openGridPositionAndSetTPSL.`);
        return true;
    }
    return false;
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade || quantityToClose <=0 || !position.symbol) return false;
    isProcessingTrade = true; let success = false;
    try { const details = await getSymbolDetails(position.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`); let qtyEff = Math.min(quantityToClose, position.quantity); qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qtyEff <= 0 || qtyEff * (position.currentPrice || position.entryPrice) < details.minNotional * 0.9) success = false;
        else { const sideOrder = (position.side === 'LONG') ? 'SELL' : 'BUY'; addLog(`[${currentBotMode.toUpperCase()}] Đóng từng phần ${qtyEff.toFixed(details.quantityPrecision)} ${position.side} ${position.symbol}.`); await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: sideOrder, positionSide: position.side, type: 'MARKET', quantity: qtyEff, newClientOrderId: `${currentBotMode.toUpperCase()}-PARTIAL-${position.side[0]}${Date.now().toString().slice(-8)}` });
            position.closedLossAmount += qtyEff; position.quantity -= qtyEff; if (position.quantity < details.stepSize) position.quantity = 0; addLog(`  Đã gửi lệnh đóng. ${position.side} còn lại: ${position.quantity.toFixed(details.quantityPrecision)}`);
            if (position.quantity > 0) { if(position.currentTPId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol:position.symbol,orderId:position.currentTPId});position.currentTPId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy TP cũ ${position.currentTPId}: ${e.msg}`);} if(position.currentSLId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol:position.symbol,orderId:position.currentSLId});position.currentSLId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy SL cũ ${position.currentSLId}: ${e.msg}`);} await sleep(500); await setTPAndSLForPosition(position, false); }
            else { addLog(`  ${position.side} ${position.symbol} đã đóng hết.`); if (position.side === 'LONG') currentLongPosition = null; else currentShortPosition = null; } success = true;
        }
    } catch (err) { addLog(`[${currentBotMode.toUpperCase()}] Lỗi đóng từng phần ${position.side}: ${err.msg || err.message}`); if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đóng từng phần ${position.side}`); success = false;
    } finally { isProcessingTrade = false; return success; }
}
async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!positionToModify || quantityToAdd <= 0 || isProcessingTrade || !positionToModify.symbol) return false;
    isProcessingTrade = true; let success = false;
    try { const details = await getSymbolDetails(positionToModify.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`); let qtyEff = quantityToAdd;
        if (reasonForAdd !== "kill_mode_reopen_closed_losing_pos" && reasonForAdd !== "mốc 0 quay đầu mở lại lỗ cả hai" && reasonForAdd !== "mốc 5 quay đầu mở lại lỗ") { const currentQty = positionToModify.quantity; const maxAdd = positionToModify.initialQuantity - currentQty; if (maxAdd <= 0) { addLog(`[${currentBotMode.toUpperCase()} ADD] ${positionToModify.side} đã đủ KL.`); success = false; } else qtyEff = Math.min(qtyEff, maxAdd); }
        if (success !== false && qtyEff > 0) { qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
            if (qtyEff <= 0 || qtyEff * (positionToModify.currentPrice || positionToModify.entryPrice) < details.minNotional * 0.9) { success = false; }
            else { const sideOrder = (positionToModify.side === 'LONG')?'BUY':'SELL'; addLog(`[${currentBotMode.toUpperCase()} ADD] Mở thêm ${qtyEff.toFixed(details.quantityPrecision)} ${positionToModify.symbol} cho ${positionToModify.side} (Lý do: ${reasonForAdd}).`); await callSignedAPI('/fapi/v1/order','POST',{symbol:positionToModify.symbol,side:sideOrder,positionSide:positionToModify.side,type:'MARKET',quantity:qtyEff,newClientOrderId:`${currentBotMode.toUpperCase()}-ADD-${positionToModify.side[0]}${Date.now().toString().slice(-10)}`});
                positionToModify.closedLossAmount -= qtyEff; if(positionToModify.closedLossAmount<0)positionToModify.closedLossAmount=0;
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                const otherP = (positionToModify.side==='LONG')?currentShortPosition:currentLongPosition;

                if(reasonForAdd==="price_near_pair_entry_reopen" || reasonForAdd === "mốc 0 quay đầu mở lại lỗ cả hai"){
                    positionToModify.nextPartialCloseLossIndex=0;
                    positionToModify.hasAdjustedSLToSpecificLevel={};
                    positionToModify.hasClosedAllLossPositionAtLastLevel=false;
                    positionToModify.lastPnlBaseResetTime = Date.now();
                    if(otherP && otherP.initialMargin>0 && reasonForAdd === "mốc 0 quay đầu mở lại lỗ cả hai"){
                        if(otherP.closedLossAmount > 0 && !otherP.hasClosedAllLossPositionAtLastLevel){
                            addLog(`  [${currentBotMode.toUpperCase()} ADD MỐC 0] Mở thêm ${otherP.closedLossAmount.toFixed(details.quantityPrecision)} cho ${otherP.side} (do mở lại cả hai).`);
                            const otherSideOrder = (otherP.side === 'LONG')?'BUY':'SELL';
                            await callSignedAPI('/fapi/v1/order','POST',{symbol:otherP.symbol,side:otherSideOrder,positionSide:otherP.side,type:'MARKET',quantity:otherP.closedLossAmount,newClientOrderId:`${currentBotMode.toUpperCase()}-ADD-${otherP.side[0]}${Date.now().toString().slice(-9)}`});
                            otherP.closedLossAmount = 0;
                        }
                        otherP.nextPartialCloseLossIndex=0;
                        otherP.hasAdjustedSLToSpecificLevel={};
                        otherP.hasClosedAllLossPositionAtLastLevel=false;
                        otherP.lastPnlBaseResetTime = Date.now();
                        addLog(`  Lệnh ${otherP.side} cũng reset về Mốc 0 do mở lại cả hai.`);
                    }
                }
                else if(reasonForAdd==="kill_mode_reopen_closed_losing_pos"||reasonForAdd==="mốc 5 quay đầu mở lại lỗ"){
                    positionToModify.nextPartialCloseLossIndex=0;
                    positionToModify.hasAdjustedSLToSpecificLevel={};
                    positionToModify.hasClosedAllLossPositionAtLastLevel=false;
                    positionToModify.lastPnlBaseResetTime = Date.now();
                    if(otherP&&otherP.initialMargin>0){
                        otherP.nextPartialCloseLossIndex=0;
                        otherP.hasAdjustedSLToSpecificLevel={};
                        otherP.lastPnlBaseResetTime = Date.now();
                        addLog(`  Lệnh thắng ${otherP.side} cũng reset về Mốc 0.`);
                    }
                }
                const newPairEntry=await getCurrentPrice(TARGET_COIN_SYMBOL); if(newPairEntry){if(currentLongPosition)currentLongPosition.pairEntryPrice=newPairEntry;if(currentShortPosition)currentShortPosition.pairEntryPrice=newPairEntry;addLog(`  Cập nhật giá vào cặp mới: ${newPairEntry.toFixed(details.pricePrecision)}`);}
                await sleep(2000); const updatedPos=await callSignedAPI('/fapi/v2/positionRisk','GET',{symbol:TARGET_COIN_SYMBOL});
                if(currentLongPosition){const lpEx=updatedPos.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='LONG');if(lpEx&&parseFloat(lpEx.positionAmt)!==0){currentLongPosition.quantity=Math.abs(parseFloat(lpEx.positionAmt));currentLongPosition.entryPrice=parseFloat(lpEx.entryPrice);}else{currentLongPosition=null;addLog("  Warn: Long pos không còn sau khi thêm.");}}
                if(currentShortPosition){const spEx=updatedPos.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='SHORT');if(spEx&&parseFloat(spEx.positionAmt)!==0){currentShortPosition.quantity=Math.abs(parseFloat(spEx.positionAmt));currentShortPosition.entryPrice=parseFloat(spEx.entryPrice);}else{currentShortPosition=null;addLog("  Warn: Short pos không còn sau khi thêm.");}}
                let tpslOk=true; if(currentLongPosition?.quantity>0){if(!await setTPAndSLForPosition(currentLongPosition,true))tpslOk=false;await sleep(300);} if(currentShortPosition?.quantity>0){if(!await setTPAndSLForPosition(currentShortPosition,true))tpslOk=false;} if(!tpslOk)addLog(`[${currentBotMode.toUpperCase()} ADD] Lỗi đặt lại TP/SL.`); success=true;
            }
        }
    } catch (err) { addLog(`[${currentBotMode.toUpperCase()} ADD] Lỗi mở lại lệnh ${positionToModify.side}: ${err.msg || err.message}`); if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi mở lại lệnh ${positionToModify.side}`); success = false;
    } finally { isProcessingTrade = false; return success; }
}
async function openGridPositionAndSetTPSL(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    if(!symbol) return null; addLog(`[LƯỚI] Mở ${tradeDirection} ${symbol} bước ${stepIndex}, giá ~${entryPriceToTarget.toFixed(4)}`);
    isProcessingTrade = true; let gridPos = null;
    try { const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi details ${symbol}.`); const maxLev = await getLeverageBracketForSymbol(symbol); if (!maxLev || maxLev < MIN_LEVERAGE_TO_TRADE) throw new Error(`Đòn bẩy ${maxLev}x < ${MIN_LEVERAGE_TO_TRADE}x.`); if (!await setLeverage(symbol, maxLev)) throw new Error(`Lỗi đặt đòn bẩy.`); await sleep(200);
        let qty = (INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO * maxLev) / entryPriceToTarget; qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision)); if (qty * entryPriceToTarget < details.minNotional) throw new Error(`Giá trị lệnh lưới ${qty*entryPriceToTarget} USDT quá nhỏ.`);
        const orderSide = (tradeDirection==='LONG')?'BUY':'SELL';
        const gridMarketClientId = `GRID-M-${tradeDirection[0]}${stepIndex}-${Date.now().toString().slice(-7)}`;
        const marketOrderRes = await callSignedAPI('/fapi/v1/order','POST',{symbol,side:orderSide,positionSide:tradeDirection,type:'MARKET',quantity:qty,newOrderRespType:'RESULT',newClientOrderId:gridMarketClientId});
        const actualEntry=parseFloat(marketOrderRes.avgPrice); const actualQty=parseFloat(marketOrderRes.executedQty); if(actualQty===0)throw new Error(`Lệnh lưới ${symbol} không khớp KL.`); addLog(`[LƯỚI] Đã MỞ ${tradeDirection} ${symbol} KL:${actualQty.toFixed(details.quantityPrecision)}, Giá:${actualEntry.toFixed(details.pricePrecision)}`);
        gridPos = {id:marketOrderRes.orderId,symbol,side:tradeDirection,entryPrice:actualEntry,quantity:actualQty,tpOrderId:null,slOrderId:null,originalAnchorPrice:sidewaysGrid.anchorPrice,stepIndex,pricePrecision:details.pricePrecision,quantityPrecision:details.quantityPrecision};
        let tpVal=actualEntry*(1+(tradeDirection==='LONG'?SIDEWAYS_TP_PERCENT_FROM_ENTRY:-SIDEWAYS_TP_PERCENT_FROM_ENTRY)); let slVal=actualEntry*(1-(tradeDirection==='LONG'?SIDEWAYS_SL_PERCENT_FROM_ENTRY:-SIDEWAYS_SL_PERCENT_FROM_ENTRY)); tpVal=parseFloat(tpVal.toFixed(details.pricePrecision));slVal=parseFloat(slVal.toFixed(details.pricePrecision)); const tpslSideClose=(tradeDirection==='LONG')?'SELL':'BUY';

        const gridTPClientId = `GRID-TP-${tradeDirection[0]}${stepIndex}-${gridPos.id.toString().slice(-5)}-${Date.now().toString().slice(-5)}`;
        const gridSLClientId = `GRID-SL-${tradeDirection[0]}${stepIndex}-${gridPos.id.toString().slice(-5)}-${Date.now().toString().slice(-5)}`;

        try{const tpOrd=await callSignedAPI('/fapi/v1/order','POST',{symbol,side:tpslSideClose,positionSide:tradeDirection,type:'TAKE_PROFIT_MARKET',stopPrice:tpVal,quantity:actualQty,timeInForce:'GTC',closePosition:'true',newClientOrderId:gridTPClientId});gridPos.tpOrderId=tpOrd.orderId;addLog(`  [LƯỚI] Đặt TP ${tradeDirection} ${symbol} @${tpVal.toFixed(details.pricePrecision)} (ID:${tpOrd.orderId})`);}catch(e){addLog(`  [LƯỚI] LỖI đặt TP ${tradeDirection} ${symbol}: ${e.msg||e.message}`);}
        try{const slOrd=await callSignedAPI('/fapi/v1/order','POST',{symbol,side:tpslSideClose,positionSide:tradeDirection,type:'STOP_MARKET',stopPrice:slVal,quantity:actualQty,timeInForce:'GTC',closePosition:'true',newClientOrderId:gridSLClientId});gridPos.slOrderId=slOrd.orderId;addLog(`  [LƯỚI] Đặt SL ${tradeDirection} ${symbol} @${slVal.toFixed(details.pricePrecision)} (ID:${slOrd.orderId})`);}catch(e){addLog(`  [LƯỚI] LỖI đặt SL ${tradeDirection} ${symbol}: ${e.msg||e.message}`);}
        sidewaysGrid.activeGridPositions.push(gridPos);
    } catch (err) { addLog(`[LƯỚI] LỖI MỞ LỆNH ${tradeDirection} ${symbol}: ${err.msg || err.message}`); if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi mở lệnh lưới ${tradeDirection} ${symbol}`); gridPos = null;
    } finally { isProcessingTrade = false; return gridPos; }
}
async function closeSpecificGridPosition(gridPosObj, reasonForClose, isSlEvent = false, isTpEvent = false) {
    if (!gridPosObj || !gridPosObj.symbol) return;
    isProcessingTrade = true;
    addLog(`[LƯỚI] Đóng lệnh ${gridPosObj.side} ${gridPosObj.symbol} ID ${gridPosObj.id} @${gridPosObj.entryPrice.toFixed(gridPosObj.pricePrecision||4)}. Lý do: ${reasonForClose}`);

    if(gridPosObj.tpOrderId){
        try{
            await callSignedAPI('/fapi/v1/order','DELETE',{symbol:gridPosObj.symbol,orderId:gridPosObj.tpOrderId});
            addLog(`  [LƯỚI] Hủy TP ${gridPosObj.tpOrderId}.`);
            gridPosObj.tpOrderId = null;
        }catch(e){
            if(e.code!==-2011) addLog(`  [LƯỚI] Lỗi hủy TP ${gridPosObj.tpOrderId}: ${e.msg||e.message}`);
            else addLog(`  [LƯỚI] TP ${gridPosObj.tpOrderId} có thể đã khớp/hủy.`);
            gridPosObj.tpOrderId = null;
        }
    }
    if(gridPosObj.slOrderId){
        try{
            await callSignedAPI('/fapi/v1/order','DELETE',{symbol:gridPosObj.symbol,orderId:gridPosObj.slOrderId});
            addLog(`  [LƯỚI] Hủy SL ${gridPosObj.slOrderId}.`);
            gridPosObj.slOrderId = null;
        }catch(e){
            if(e.code!==-2011) addLog(`  [LƯỚI] Lỗi hủy SL ${gridPosObj.slOrderId}: ${e.msg||e.message}`);
            else addLog(`  [LƯỚI] SL ${gridPosObj.slOrderId} có thể đã khớp/hủy.`);
            gridPosObj.slOrderId = null;
        }
    }
    await sleep(300);

    if(!isSlEvent && !isTpEvent && gridPosObj.quantity > 0){
        try{
            const details=await getSymbolDetails(gridPosObj.symbol);
            if(details){
                const qtyClose=parseFloat(gridPosObj.quantity.toFixed(details.quantityPrecision));
                const sideCloseOrder=gridPosObj.side==='LONG'?'SELL':'BUY';

                const positions=await callSignedAPI('/fapi/v2/positionRisk','GET',{symbol:gridPosObj.symbol});
                const currentActualPos=positions.find(p=>p.symbol===gridPosObj.symbol&&p.positionSide===gridPosObj.side);
                const actualQtyOnEx=Math.abs(parseFloat(currentActualPos?.positionAmt||"0"));

                if(actualQtyOnEx > 0 && actualQtyOnEx >= qtyClose * 0.9){
                    addLog(`  [LƯỚI] Gửi MARKET đóng ${qtyClose} ${gridPosObj.side} ${gridPosObj.symbol} (Lý do: ${reasonForClose})`);
                    const orderIdSuffix = gridPosObj.id.toString().length > 8 ? gridPosObj.id.toString().slice(-8) : gridPosObj.id.toString();
                    const timestampSuffix = Date.now().toString().slice(-8);
                    let manualCloseClientId = `GMC_${gridPosObj.side[0]}${gridPosObj.stepIndex}_${orderIdSuffix}_${timestampSuffix}`;
                    if (manualCloseClientId.length > 32) manualCloseClientId = manualCloseClientId.slice(0,32);

                    await callSignedAPI('/fapi/v1/order','POST',{symbol:gridPosObj.symbol,side:sideCloseOrder,positionSide:gridPosObj.side,type:'MARKET',quantity:qtyClose,newClientOrderId:manualCloseClientId});
                } else if (actualQtyOnEx > 0) {
                    addLog(`  [LƯỚI] KL trên sàn (${actualQtyOnEx.toFixed(details.quantityPrecision)}) nhỏ hơn KL cần đóng ${qtyClose}. Có thể lệnh đã được đóng một phần hoặc toàn bộ.`);
                } else {
                     addLog(`  [LƯỚI] Không tìm thấy vị thế ${gridPosObj.side} ${gridPosObj.symbol} trên sàn để đóng MARKET (Lý do: ${reasonForClose}).`);
                }
            }
        }catch(err){
            addLog(`  [LƯỚI] Lỗi MARKET đóng ${gridPosObj.side} ID ${gridPosObj.id}: ${err.msg||err.message}`);
        }
    }

    sidewaysGrid.activeGridPositions=sidewaysGrid.activeGridPositions.filter(p=>p.id!==gridPosObj.id);
    addLog(`  [LƯỚI] Đã xóa lệnh lưới ID ${gridPosObj.id} khỏi theo dõi. Còn ${sidewaysGrid.activeGridPositions.length}.`);

    if(isSlEvent) sidewaysGrid.sidewaysStats.slMatchedCount++;
    if(isTpEvent) sidewaysGrid.sidewaysStats.tpMatchedCount++;
    isProcessingTrade=false;
}
async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || isProcessingTrade || sidewaysGrid.isClearingForSwitch || !TARGET_COIN_SYMBOL) return;
    const details = await getSymbolDetails(TARGET_COIN_SYMBOL); if (!details) { addLog("[LƯỚI] Không có details, không thể quản lý lưới."); return; } const pricePrecision = details.pricePrecision;
    const posFromAnchor = sidewaysGrid.activeGridPositions.filter(p => p.originalAnchorPrice === sidewaysGrid.anchorPrice);
    if (posFromAnchor.length === 0) { let sideToOpen=null,targetEntry=null; if(currentMarketPrice>=sidewaysGrid.anchorPrice*(1+SIDEWAYS_INITIAL_TRIGGER_PERCENT)){sideToOpen='SHORT';targetEntry=sidewaysGrid.anchorPrice*(1+SIDEWAYS_INITIAL_TRIGGER_PERCENT);}else if(currentMarketPrice<=sidewaysGrid.anchorPrice*(1-SIDEWAYS_INITIAL_TRIGGER_PERCENT)){sideToOpen='LONG';targetEntry=sidewaysGrid.anchorPrice*(1-SIDEWAYS_INITIAL_TRIGGER_PERCENT);} if(sideToOpen){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger. Mở ${sideToOpen} quanh ${targetEntry.toFixed(pricePrecision)}.`);await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL,sideToOpen,targetEntry,0);}}
    const MAX_STEPS=Math.floor(SIDEWAYS_GRID_RANGE_PERCENT/SIDEWAYS_GRID_STEP_PERCENT);
    for(let i=1;i<=MAX_STEPS;i++){const shortTrig=sidewaysGrid.anchorPrice*(1+i*SIDEWAYS_GRID_STEP_PERCENT);if(currentMarketPrice>=shortTrig&&!sidewaysGrid.activeGridPositions.find(p=>p.side==='SHORT'&&p.stepIndex===i&&p.originalAnchorPrice===sidewaysGrid.anchorPrice)){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger Short bước ${i}.`);await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL,'SHORT',shortTrig,i);} const longTrig=sidewaysGrid.anchorPrice*(1-i*SIDEWAYS_GRID_STEP_PERCENT);if(currentMarketPrice<=longTrig&&!sidewaysGrid.activeGridPositions.find(p=>p.side==='LONG'&&p.stepIndex===i&&p.originalAnchorPrice===sidewaysGrid.anchorPrice)){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger Long bước ${i}.`);await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL,'LONG',longTrig,i);}}
    if(currentMarketPrice>sidewaysGrid.gridUpperLimit||currentMarketPrice<sidewaysGrid.gridLowerLimit){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) vượt phạm vi. Dịch chuyển anchor.`);sidewaysGrid.anchorPrice=currentMarketPrice;sidewaysGrid.gridUpperLimit=sidewaysGrid.anchorPrice*(1+SIDEWAYS_GRID_RANGE_PERCENT);sidewaysGrid.gridLowerLimit=sidewaysGrid.anchorPrice*(1-SIDEWAYS_GRID_RANGE_PERCENT);sidewaysGrid.lastGridMoveTime=Date.now();}
    if(Date.now()-(sidewaysGrid.lastVolatilityCheckTime||0)>VOLATILITY_CHECK_INTERVAL_MS){sidewaysGrid.lastVolatilityCheckTime=Date.now();await fetchAndCacheTopCoinsFromVPS1(true);const coinDataV1=getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);const vps1Vol=coinDataV1?Math.abs(coinDataV1.changePercent):null;if(vps1Vol!==null&&vps1Vol>=OVERALL_VOLATILITY_THRESHOLD_VPS1){addLog(`[LƯỚI->KILL] Phát hiện ${TARGET_COIN_SYMBOL} có Vol VPS1 (${vps1Vol.toFixed(2)}%) >= ${OVERALL_VOLATILITY_THRESHOLD_VPS1}%.`);if(!sidewaysGrid.isClearingForSwitch){sidewaysGrid.isClearingForSwitch=true;await closeAllSidewaysPositionsAndOrders(`Chuyển KILL (Vol VPS1 ${vps1Vol.toFixed(2)}%)`);if(sidewaysGrid.switchDelayTimeout)clearTimeout(sidewaysGrid.switchDelayTimeout);addLog(`  [LƯỚI] Chờ ${MODE_SWITCH_DELAY_MS/1000}s trước khi kích hoạt KILL.`);sidewaysGrid.switchDelayTimeout=setTimeout(async()=>{addLog(`[LƯỚI] Hết chờ. Kích hoạt KILL.`);currentBotMode='kill';sidewaysGrid.isClearingForSwitch=false;sidewaysGrid.isActive=false;if(currentLongPosition)currentLongPosition=null;if(currentShortPosition)currentShortPosition=null;await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);if(botRunning)scheduleNextMainCycle(1000);},MODE_SWITCH_DELAY_MS);}return;}}
}
async function closeAllSidewaysPositionsAndOrders(reason) {
    if (!TARGET_COIN_SYMBOL) return; addLog(`[LƯỚI] Đóng tất cả vị thế/lệnh Sideways ${TARGET_COIN_SYMBOL}. Lý do: ${reason}`);
    const activeGridCopy = [...sidewaysGrid.activeGridPositions]; if (activeGridCopy.length === 0) addLog("  [LƯỚI] Không có vị thế lưới nào.");
    for (const pos of activeGridCopy) { await closeSpecificGridPosition(pos, `Đóng toàn bộ (${TARGET_COIN_SYMBOL}): ${reason}`); await sleep(500); }
    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
    sidewaysGrid.isActive = false; sidewaysGrid.anchorPrice = null; sidewaysGrid.gridUpperLimit = null; sidewaysGrid.gridLowerLimit = null;
    sidewaysGrid.activeGridPositions = []; sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
    addLog(`[LƯỚI] Hoàn tất đóng và dọn dẹp Sideways ${TARGET_COIN_SYMBOL}.`);
}

async function checkOverallTPSL() {
    if (!botRunning || isProcessingTrade) return false;

    let currentTrueOverallPnl = cumulativeRealizedPnlSinceStart;

    if (currentLongPosition?.initialMargin > 0 && typeof currentLongPosition.unrealizedPnl === 'number') {
        currentTrueOverallPnl += currentLongPosition.unrealizedPnl;
    }
    if (currentShortPosition?.initialMargin > 0 && typeof currentShortPosition.unrealizedPnl === 'number') {
        currentTrueOverallPnl += currentShortPosition.unrealizedPnl;
    }

    if (sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0 && currentMarketPrice && TARGET_COIN_SYMBOL) {
        for (const pos of sidewaysGrid.activeGridPositions) {
            if (pos.symbol === TARGET_COIN_SYMBOL && pos.entryPrice && pos.quantity) {
                const unrealizedPnlGridPos = (currentMarketPrice - pos.entryPrice) * pos.quantity * (pos.side === 'LONG' ? 1 : -1);
                currentTrueOverallPnl += unrealizedPnlGridPos;
            }
        }
    }

    if (overallTakeProfit > 0 && currentTrueOverallPnl >= overallTakeProfit) {
        addLog(`[TRUE OVERALL TP] PNL Tổng Cộng Dồn Hiện Tại (${currentTrueOverallPnl.toFixed(2)}) đạt mục tiêu TP (${overallTakeProfit.toFixed(2)}). Dừng bot.`);
        await stopBotLogicInternal(`True Overall TP Reached: ${currentTrueOverallPnl.toFixed(2)} >= ${overallTakeProfit.toFixed(2)}`);
        return true;
    }
    if (overallStopLoss < 0 && currentTrueOverallPnl <= overallStopLoss) {
        addLog(`[TRUE OVERALL SL] PNL Tổng Cộng Dồn Hiện Tại (${currentTrueOverallPnl.toFixed(2)}) đạt mục tiêu SL (${overallStopLoss.toFixed(2)}). Dừng bot.`);
        await stopBotLogicInternal(`True Overall SL Reached: ${currentTrueOverallPnl.toFixed(2)} <= ${overallStopLoss.toFixed(2)}`);
        return true;
    }
    return false;
}

async function runTradingLogic() {
    if (!botRunning || isProcessingTrade || sidewaysGrid.isClearingForSwitch || isOpeningInitialPair) {
        if(isProcessingTrade) addLog("runTradingLogic: Bỏ qua do isProcessingTrade=true");
        if(sidewaysGrid.isClearingForSwitch) addLog("runTradingLogic: Bot đang dọn lưới/chuyển mode, bỏ qua.");
        if(isOpeningInitialPair) addLog("runTradingLogic: Bot đang mở cặp lệnh Kill ban đầu, bỏ qua.");
        return;
    }
    if (await checkOverallTPSL()) return;

    if (!TARGET_COIN_SYMBOL || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive && !isOpeningInitialPair)) {
        addLog(`TARGET_COIN_SYMBOL (${TARGET_COIN_SYMBOL || 'N/A'}) chưa có hoặc không có lệnh/lưới. Chọn coin mới...`);
        const newCoinSymbol = await selectTargetCoin(!TARGET_COIN_SYMBOL);
        if (newCoinSymbol) {
            if (TARGET_COIN_SYMBOL && TARGET_COIN_SYMBOL !== newCoinSymbol) {
                addLog(`TARGET_COIN_SYMBOL đổi từ ${TARGET_COIN_SYMBOL} sang ${newCoinSymbol}. Dọn dẹp coin cũ và chờ.`);
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL, true);
                return;
            }
            TARGET_COIN_SYMBOL = newCoinSymbol;
            totalProfit = 0; totalLoss = 0; netPNL = 0;
            currentLongPosition = null; currentShortPosition = null;
            sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForSwitch: false, switchDelayTimeout: null };
            if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; }
            setupMarketDataStream(TARGET_COIN_SYMBOL);
        } else {
            addLog("Không chọn được coin mục tiêu mới. Thử lại sau 1 phút.");
            if (botRunning) scheduleNextMainCycle(60000); return;
        }
    }

    if (!TARGET_COIN_SYMBOL) { if (botRunning) scheduleNextMainCycle(60000); return; }

    await fetchAndCacheTopCoinsFromVPS1(true);
    const currentCoinDataVPS1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1Volatility = currentCoinDataVPS1 ? Math.abs(currentCoinDataVPS1.changePercent) : null;
    const prevMode = currentBotMode;

    if (vps1Volatility !== null) {
        if (vps1Volatility < OVERALL_VOLATILITY_THRESHOLD_VPS1 && currentBotMode === 'kill' && !currentLongPosition && !currentShortPosition && !isOpeningInitialPair) {
            currentBotMode = 'sideways';
        } else if (vps1Volatility >= OVERALL_VOLATILITY_THRESHOLD_VPS1 && currentBotMode === 'sideways' && !sidewaysGrid.isClearingForSwitch) {
            if (!currentLongPosition && !currentShortPosition) {
                currentBotMode = 'kill';
                if (sidewaysGrid.isActive) {
                    addLog(`Vol VPS1 (${TARGET_COIN_SYMBOL}: ${vps1Volatility.toFixed(2)}%) >= ${OVERALL_VOLATILITY_THRESHOLD_VPS1}%. Chuyển Sideways -> Kill. Đóng lưới...`);
                    sidewaysGrid.isClearingForSwitch = true;
                    await closeAllSidewaysPositionsAndOrders("Chuyển sang Kill do Vol VPS1 tăng");
                    if(sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
                    sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                        addLog(`Hết chờ đóng lưới (Vol VPS1 tăng). Kích hoạt Kill.`);
                        sidewaysGrid.isClearingForSwitch = false;
                        if (botRunning) scheduleNextMainCycle(1000);
                    }, MODE_SWITCH_DELAY_MS);
                    return;
                }
            }
        }
    }

    if (prevMode !== currentBotMode && !sidewaysGrid.isClearingForSwitch) {
        addLog(`Chế độ đổi từ ${prevMode.toUpperCase()} sang ${currentBotMode.toUpperCase()} (Vol VPS1 ${TARGET_COIN_SYMBOL}: ${vps1Volatility !== null ? vps1Volatility.toFixed(2) + '%' : 'N/A'})`);
        if (currentBotMode === 'sideways' && (currentLongPosition || currentShortPosition)) { addLog("  Có lệnh Kill, không vào Sideways."); currentBotMode = 'kill';}
        if(currentBotMode === 'kill' && sidewaysGrid.isActive) {
             addLog("Chuyển từ Sideways sang Kill. Dọn lưới và chờ...");
             sidewaysGrid.isClearingForSwitch = true;
             await closeAllSidewaysPositionsAndOrders("Chuyển sang Kill mode từ runTradingLogic");
             if(sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
             sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                addLog("Hết chờ dọn lưới. Tiếp tục với Kill mode.");
                sidewaysGrid.isClearingForSwitch = false;
                if(botRunning) scheduleNextMainCycle(1000);
             }, MODE_SWITCH_DELAY_MS);
             return;
        }
    }

    if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive && !sidewaysGrid.isClearingForSwitch && !isOpeningInitialPair) {
        if (currentBotMode === 'kill') {
            addLog(`Bắt đầu chu kỳ KILL mới cho ${TARGET_COIN_SYMBOL} (Vol VPS1: ${vps1Volatility !== null ? vps1Volatility.toFixed(2) + '%' : 'N/A'})...`);
            isOpeningInitialPair = true;
            try {
                if(!await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL)) {
                    addLog("Lỗi hủy lệnh chờ trước khi mở cặp Kill mới. Dừng tạm.");
                    isOpeningInitialPair = false;
                    if(botRunning) scheduleNextMainCycle(5000);
                    return;
                }
                await sleep(500);

                const maxLev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
                if (!maxLev || maxLev < MIN_LEVERAGE_TO_TRADE) { TARGET_COIN_SYMBOL = null; isOpeningInitialPair = false; if(botRunning) scheduleNextMainCycle(1000); return; }
                const priceNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!priceNewPair) { isOpeningInitialPair = false; if (botRunning) scheduleNextMainCycle(); return; }

                currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLev, priceNewPair);
                if (!currentLongPosition) { isOpeningInitialPair = false; if (botRunning) scheduleNextMainCycle(); return; }

                await sleep(800);

                currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLev, priceNewPair);
                if (!currentShortPosition) {
                    if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT cặp Kill', 'LONG');
                    currentLongPosition = null;
                    isOpeningInitialPair = false;
                    if (botRunning) scheduleNextMainCycle();
                    return;
                }

                await sleep(3000);

                let tpslSet = true;
                if (currentLongPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslSet = false; }
                await sleep(300);
                if (currentShortPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslSet = false; }

                if (!tpslSet) {
                    addLog("  Lỗi đặt TP/SL cặp Kill. Đóng cả hai.");
                    if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi TP/SL Kill', 'LONG');
                    if (currentShortPosition) await closePosition(currentShortPosition.symbol, 'Lỗi TP/SL Kill', 'SHORT');
                    await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                    isOpeningInitialPair = false;
                    return;
                }
                isOpeningInitialPair = false;
            } catch (err) {
                addLog(`  Lỗi mở cặp Kill: ${err.msg || err.message}`);
                isOpeningInitialPair = false;
                if(err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi mở cặp Kill ${TARGET_COIN_SYMBOL}`);
                if(botRunning) scheduleNextMainCycle();
            }
        } else if (currentBotMode === 'sideways') {
            addLog(`[LƯỚI] Kích hoạt Sideways cho ${TARGET_COIN_SYMBOL} (Vol VPS1: ${vps1Volatility !== null ? vps1Volatility.toFixed(2) + '%' : 'N/A'}).`);
            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            await sleep(500);
            const priceAnchor = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!priceAnchor) { if(botRunning) scheduleNextMainCycle(); return; }
            const details = await getSymbolDetails(TARGET_COIN_SYMBOL); if(!details) { if(botRunning) scheduleNextMainCycle(); return; }
            sidewaysGrid.isActive = true; sidewaysGrid.anchorPrice = priceAnchor;
            sidewaysGrid.gridUpperLimit = priceAnchor * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
            sidewaysGrid.gridLowerLimit = priceAnchor * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
            sidewaysGrid.lastGridMoveTime = Date.now(); sidewaysGrid.lastVolatilityCheckTime = Date.now();
            sidewaysGrid.activeGridPositions = []; sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
        }
    }

    if(botRunning && !nextScheduledCycleTimeout) scheduleNextMainCycle();
    if (botRunning && !positionCheckInterval && (currentLongPosition || currentShortPosition || sidewaysGrid.isActive )) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        const checkIntervalMs = currentBotMode === 'kill' ? 5000 : (sidewaysGrid.isActive ? 3000 : 7000) ;
        addLog(`Thiết lập interval kiểm tra vị thế (${currentBotMode}) mỗi ${checkIntervalMs/1000}s.`);
        positionCheckInterval = setInterval(async () => {
            if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForSwitch && !isOpeningInitialPair) {
                try { await manageOpenPosition(); }
                catch (e) { addLog(`Lỗi interval manageOpenPosition: ${e.msg || e.message}`); if(e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi interval manageOpenPosition`); }
            } else if ((!botRunning || sidewaysGrid.isClearingForSwitch || isOpeningInitialPair) && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
        }, checkIntervalMs);
    } else if ((!botRunning || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive)) && positionCheckInterval) {
        clearInterval(positionCheckInterval); positionCheckInterval = null;
    }
}

async function manageOpenPosition() {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForSwitch || !TARGET_COIN_SYMBOL || isOpeningInitialPair) return;
    if (await checkOverallTPSL()) return;

    await fetchAndCacheTopCoinsFromVPS1(true);
    const currentCoinDataFromVPS1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1VolForCurrentCoin = currentCoinDataFromVPS1 ? Math.abs(currentCoinDataFromVPS1.changePercent) : null;

    if (currentBotMode === 'kill') {
        if (!currentLongPosition && !currentShortPosition && botRunning) {
            await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }
        if (!currentLongPosition || !currentShortPosition) {
             return;
        }

        try {
            const positionsData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            let longPosEx = positionsData.find(p => p.positionSide === 'LONG' && p.symbol === TARGET_COIN_SYMBOL);
            let shortPosEx = positionsData.find(p => p.positionSide === 'SHORT' && p.symbol === TARGET_COIN_SYMBOL);

            if (currentLongPosition) { if (longPosEx && Math.abs(parseFloat(longPosEx.positionAmt)) > 0) { currentLongPosition.unrealizedPnl = parseFloat(longPosEx.unRealizedProfit); currentLongPosition.currentPrice = parseFloat(longPosEx.markPrice); currentLongPosition.quantity = Math.abs(parseFloat(longPosEx.positionAmt)); currentLongPosition.entryPrice = parseFloat(longPosEx.entryPrice); } else { addLog(`[KILL] Long ${TARGET_COIN_SYMBOL} không còn trên sàn.`); currentLongPosition = null; }}
            if (currentShortPosition) { if (shortPosEx && Math.abs(parseFloat(shortPosEx.positionAmt)) > 0) { currentShortPosition.unrealizedPnl = parseFloat(shortPosEx.unRealizedProfit); currentShortPosition.currentPrice = parseFloat(shortPosEx.markPrice); currentShortPosition.quantity = Math.abs(parseFloat(shortPosEx.positionAmt)); currentShortPosition.entryPrice = parseFloat(shortPosEx.entryPrice); } else { addLog(`[KILL] Short ${TARGET_COIN_SYMBOL} không còn trên sàn.`); currentShortPosition = null; }}

            if (!currentLongPosition && !currentShortPosition && botRunning) {
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                return;
            }
            if (!currentLongPosition || !currentShortPosition) {
                 return;
            }

            const pA = currentLongPosition;
            const pB = currentShortPosition;
            const pairEntry = pA.pairEntryPrice;
            const winningPos = (pA.unrealizedPnl >= pB.unrealizedPnl) ? pA : pB;
            const losingPos = (winningPos === pA) ? pB : pA;
            const currentMocIndex = winningPos.nextPartialCloseLossIndex || 0;

            if (pairEntry > 0 && currentMarketPrice && currentMocIndex < PARTIAL_CLOSE_INDEX_5 && Math.abs(currentMarketPrice - pairEntry) <= (pairEntry * 0.0005) && !sidewaysGrid.isClearingForSwitch) {
                addLog(`[KILL CHECK] Giá về entry, mốc < 5. Tìm cơ hội chuyển đổi...`);
                const allVps1Coins = await fetchAndCacheTopCoinsFromVPS1(true);
                const bestAlternativeCoin = allVps1Coins.find(c => c.symbol !== TARGET_COIN_SYMBOL && Math.abs(c.changePercent) >= OVERALL_VOLATILITY_THRESHOLD_VPS1);

                if (bestAlternativeCoin && Math.abs(bestAlternativeCoin.changePercent) > (vps1VolForCurrentCoin || 0)) {
                    addLog(`[KILL->KILL & ĐỔI COIN] Giá về entry. Tìm thấy coin tốt hơn: ${bestAlternativeCoin.symbol} (Vol: ${bestAlternativeCoin.changePercent.toFixed(2)}%).`);
                    sidewaysGrid.isClearingForSwitch = true;
                    if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển sang coin tốt hơn ${bestAlternativeCoin.symbol}`, 'LONG');
                    if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển sang coin tốt hơn ${bestAlternativeCoin.symbol}`, 'SHORT');
                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                    if (sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
                    sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                        sidewaysGrid.isClearingForSwitch = false;
                        const oldCoin = TARGET_COIN_SYMBOL;
                        TARGET_COIN_SYMBOL = bestAlternativeCoin.symbol;
                        totalProfit = 0; totalLoss = 0; netPNL = 0; currentLongPosition = null; currentShortPosition = null;
                        if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; }
                        setupMarketDataStream(TARGET_COIN_SYMBOL);
                        await cleanupAndResetCycle(oldCoin, false);
                        if(botRunning) scheduleNextMainCycle(1000);
                    }, COIN_SWITCH_DELAY_MS);
                    return;
                } else {
                    addLog(`[KILL->SIDEWAYS] Giá về entry. Không có coin tốt hơn. Chuyển sang Sideways.`);
                    sidewaysGrid.isClearingForSwitch = true;
                    if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển sang Sideways`, 'LONG');
                    if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển sang Sideways`, 'SHORT');
                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                    if (sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
                    sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                         addLog("Hết chờ dọn lệnh. Kích hoạt Sideways.");
                         currentBotMode = 'sideways';
                         sidewaysGrid.isClearingForSwitch = false;
                         currentLongPosition = null; currentShortPosition = null;
                         if(botRunning) scheduleNextMainCycle(1000);
                    }, MODE_SWITCH_DELAY_MS);
                    return;
                }
            }

            if (pA.closedLossAmount > 0 && Math.abs(currentMarketPrice - pairEntry) <= (pairEntry * 0.0005) && !isProcessingTrade) {
                 addLog(`[KILL REOPEN MỐC 0] Giá ${TARGET_COIN_SYMBOL} về gần entry cặp. Mở lại toàn bộ phần đã đóng.`);
                 await addPosition(pA, pA.closedLossAmount, "mốc 0 quay đầu mở lại lỗ cả hai");
                 return;
            }
            
            if (losingPos.quantity === 0 && winningPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel['LosingPosClosed']) {
                const moc5PnlForWinning = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5];
                const targetPnlAtSLWinning_USD = (winningPos.initialMargin * (moc5PnlForWinning / 100));
                const priceChangeForSL = (targetPnlAtSLWinning_USD - winningPos.unrealizedPnl) / winningPos.quantity;
                let slPriceForWinning;
                if (winningPos.side === 'LONG') { slPriceForWinning = winningPos.currentPrice + priceChangeForSL; } else { slPriceForWinning = winningPos.currentPrice - priceChangeForSL; }
                slPriceForWinning = parseFloat(slPriceForWinning.toFixed(winningPos.pricePrecision));
                const details = await getSymbolDetails(winningPos.symbol);
                if (winningPos.side === 'LONG' && slPriceForWinning >= winningPos.currentPrice) { slPriceForWinning = parseFloat((winningPos.currentPrice - details.tickSize).toFixed(winningPos.pricePrecision)); }
                if (winningPos.side === 'SHORT' && slPriceForWinning <= winningPos.currentPrice) { slPriceForWinning = parseFloat((winningPos.currentPrice + details.tickSize).toFixed(winningPos.pricePrecision)); }
                addLog(`[KILL] Lệnh lỗ ${losingPos.side} đã đóng hết. Dời SL lệnh lãi ${winningPos.side} về giá tương đương PNL Mốc 5 (Giá SL: ${slPriceForWinning.toFixed(winningPos.pricePrecision)}).`);
                if(winningPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:winningPos.symbol, orderId:winningPos.currentSLId}); winningPos.currentSLId=null;} catch(e){if(e.code !== -2011)addLog(`  Warn: Lỗi hủy SL cũ lệnh lãi: ${e.msg}`);} }
                await sleep(200);
                try {
                   const newSLOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: winningPos.symbol, side: (winningPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: winningPos.side, type: 'STOP_MARKET', stopPrice: slPriceForWinning, quantity: winningPos.quantity, timeInForce: 'GTC', closePosition: 'true', newClientOrderId: `KILL-ADJSL-WIN-${winningPos.side[0]}${Date.now().toString().slice(-7)}` });
                   if (newSLOrder.orderId) { winningPos.currentSLId = newSLOrder.orderId; winningPos.hasAdjustedSLToSpecificLevel['LosingPosClosed'] = true; addLog(`    Đã đặt SL mới ${newSLOrder.orderId} cho lệnh lãi ${winningPos.side}.`); }
                } catch (e) {
                   addLog(`    Lỗi đặt SL mới cho lệnh lãi ${winningPos.side}: ${e.msg || e.message}.`);
                   await setTPAndSLForPosition(winningPos, false);
                }
                return;
            }

            if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && winningPos.initialMargin > 0) {
                const pnlPctWin = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

                if (currentMocIndex >= winningPos.partialCloseLossLevels.length) {
                    if (losingPos.quantity > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel) { addLog(`[KILL] Lệnh thắng ${winningPos.side} đã qua hết mốc. Đóng lệnh lỗ ${losingPos.side}.`); await closePosition(losingPos.symbol, `Thắng qua hết mốc, đóng lỗ`, losingPos.side); losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; }
                    return;
                }

                const targetMocRelPnl = winningPos.partialCloseLossLevels[currentMocIndex];
                const moc5RelPnlVal = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5];
                const moc8RelPnlVal = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8];
                if (moc5RelPnlVal === undefined || moc8RelPnlVal === undefined) { addLog(`Lỗi: partialCloseLossLevels không đúng.`); return; }

                if (pnlPctWin >= targetMocRelPnl && losingPos.quantity > 0) {
                    addLog(`[KILL MÓC] ${winningPos.side} ${TARGET_COIN_SYMBOL} đạt Mốc ${currentMocIndex + 1} (PNL ${pnlPctWin.toFixed(1)}% >= ngưỡng ${targetMocRelPnl.toFixed(1)}%).`);

                    let qtyFractionToClose = 0.10;
                    if (currentMocIndex === PARTIAL_CLOSE_INDEX_5) qtyFractionToClose = 0.20;
                    else if (currentMocIndex >= PARTIAL_CLOSE_INDEX_8) qtyFractionToClose = 1.00;

                    const qtyToCloseLosing = losingPos.initialQuantity * qtyFractionToClose;
                    if(await closePartialPosition(losingPos, qtyToCloseLosing)) {
                        winningPos.nextPartialCloseLossIndex++;
                        addLog(`  Đã tăng mốc lệnh thắng ${winningPos.side} lên Mốc ${winningPos.nextPartialCloseLossIndex +1}.`);
                    } else {
                        addLog(`  Không thể đóng một phần lệnh lỗ ${losingPos.side}. Mốc lệnh thắng không tăng.`);
                    }
                    if (losingPos.quantity <= 0) {
                        losingPos.hasClosedAllLossPositionAtLastLevel = true;
                    }
                }
            }

        } catch (err) { addLog(`Lỗi manageOpenPosition (Kill): ${err.msg || err.message}`); if(err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi manageOpenPosition (Kill) ${TARGET_COIN_SYMBOL}`); }
    } else if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        await manageSidewaysGridLogic();
    } else if (currentBotMode === 'sideways' && !sidewaysGrid.isActive) {
        if (vps1VolForCurrentCoin !== null && vps1VolForCurrentCoin >= OVERALL_VOLATILITY_THRESHOLD_VPS1) {
             if (!currentLongPosition && !currentShortPosition) {
                addLog(`[SIDEWAYS->KILL] Vol VPS1 ${TARGET_COIN_SYMBOL} (${vps1VolForCurrentCoin.toFixed(2)}%) >= ${OVERALL_VOLATILITY_THRESHOLD_VPS1}%. Chuyển sang KILL (từ manageOpenPosition).`);
                sidewaysGrid.isClearingForSwitch = true;
                await closeAllSidewaysPositionsAndOrders("Chuyển sang Kill do Vol VPS1 tăng (từ manageOpenPosition)");
                if(sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
                sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                    addLog(`Hết chờ đóng lưới (Vol VPS1 tăng). Kích hoạt Kill.`);
                    currentBotMode = 'kill'; sidewaysGrid.isClearingForSwitch = false;
                    if (botRunning) scheduleNextMainCycle(1000);
                }, MODE_SWITCH_DELAY_MS);
                return;
            }
        } else {
             scheduleNextMainCycle(1000);
             return;
        }
    }
};

async function processTradeResult(orderInfo) {
    if (isProcessingTrade && orderInfo.X !== 'FILLED' && orderInfo.X !== 'CANCELED' && orderInfo.X !== 'REJECTED' && orderInfo.X !== 'EXPIRED') return;
    const wasProcessing = isProcessingTrade;
    const { X: orderStatusInitial } = orderInfo;
    if (orderStatusInitial !== 'NEW' && orderStatusInitial !== 'PARTIALLY_FILLED') {
        isProcessingTrade = true;
    }
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide, z: filledQtyStr, S: sideOrder, ap: avgPriceStr, ot: orderType, ci: clientOrderId } = orderInfo;
    const filledQty = parseFloat(filledQtyStr); const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || (orderStatus !== 'FILLED' && orderStatus !== 'CANCELED' && orderStatus !== 'EXPIRED' && orderStatus !== 'REJECTED') ) {
        if(!wasProcessing && orderStatus !== 'NEW' && orderStatus !== 'PARTIALLY_FILLED') isProcessingTrade = false;
        return;
    }
    if (orderStatus === 'FILLED' && filledQty === 0) {
        if(!wasProcessing && orderStatus !== 'NEW' && orderStatus !== 'PARTIALLY_FILLED') isProcessingTrade = false; return;
    }

    if (orderStatus === 'FILLED') {
        addLog(`[Trade FILLED ${TARGET_COIN_SYMBOL}] ClientID: ${clientOrderId || 'N/A'} (ID: ${orderId}) | ${positionSide} ${sideOrder} ${orderType} | KL: ${filledQty.toFixed(4)} @ ${parseFloat(avgPriceStr).toFixed(4)} | PNL: ${realizedPnl.toFixed(4)}`);
        if (realizedPnl !== 0) {
            if (realizedPnl > 0) totalProfit += realizedPnl;
            else totalLoss += Math.abs(realizedPnl);
            netPNL = totalProfit - totalLoss;
            addLog(`  PNL Ròng (coin ${TARGET_COIN_SYMBOL} đã chốt): ${netPNL.toFixed(2)} (L: ${totalProfit.toFixed(2)}, T: ${totalLoss.toFixed(2)})`);

            cumulativeRealizedPnlSinceStart += realizedPnl;
            addLog(`  PNL Cộng Dồn Đã Chốt (từ khi bot chạy): ${cumulativeRealizedPnlSinceStart.toFixed(2)}`);
        }
    } else if (orderStatus === 'CANCELED' || orderStatus === 'REJECTED' || orderStatus === 'EXPIRED') {
         addLog(`[Trade Update ${TARGET_COIN_SYMBOL}] Lệnh ${clientOrderId || orderId} (${positionSide} ${sideOrder} ${orderType}) bị ${orderStatus}.`);
    }

    if (await checkOverallTPSL()) { if(!wasProcessing && orderStatus !== 'NEW' && orderStatus !== 'PARTIALLY_FILLED') isProcessingTrade = false; return; }

    if (sidewaysGrid.isActive && TARGET_COIN_SYMBOL === symbol) {
        const matchedGridPos = sidewaysGrid.activeGridPositions.find(p => p.tpOrderId === orderId || p.slOrderId === orderId);
        if (matchedGridPos) {
            if (orderStatus === 'FILLED') {
                const isTp = matchedGridPos.tpOrderId === orderId; const isSl = matchedGridPos.slOrderId === orderId;
                if (isTp) { addLog(`  [LƯỚI TP] Lệnh TP lưới ${matchedGridPos.side} ${symbol} (ID gốc: ${matchedGridPos.id}) khớp.`); await closeSpecificGridPosition(matchedGridPos, `TP lưới khớp`, false, true); }
                else if (isSl) { addLog(`  [LƯỚI SL] Lệnh SL lưới ${matchedGridPos.side} ${symbol} (ID gốc: ${matchedGridPos.id}) khớp.`); await closeSpecificGridPosition(matchedGridPos, `SL lưới khớp`, true, false); }
            } else if (orderStatus === 'CANCELED' || orderStatus === 'EXPIRED' || orderStatus === 'REJECTED') {
                 if(matchedGridPos.tpOrderId === orderId) { matchedGridPos.tpOrderId = null; addLog(`  [LƯỚI] TP ${orderId} của lệnh lưới ${matchedGridPos.id} ${orderStatus}.`);}
                 if(matchedGridPos.slOrderId === orderId) { matchedGridPos.slOrderId = null; addLog(`  [LƯỚI] SL ${orderId} của lệnh lưới ${matchedGridPos.id} ${orderStatus}.`);}
            }
            if(!wasProcessing && orderStatus !== 'NEW' && orderStatus !== 'PARTIALLY_FILLED') isProcessingTrade = false; return;
        }
    }

    if (orderStatus !== 'FILLED') {
        if(!wasProcessing && orderStatus !== 'NEW' && orderStatus !== 'PARTIALLY_FILLED') isProcessingTrade = false;
        return;
    }

    const isLongKillTP = currentLongPosition && orderId === currentLongPosition.currentTPId; const isLongKillSL = currentLongPosition && orderId === currentLongPosition.currentSLId;
    const isShortKillTP = currentShortPosition && orderId === currentShortPosition.currentTPId; const isShortKillSL = currentShortPosition && orderId === currentShortPosition.currentSLId;
    let closedKillPosSide = null;
    if (isLongKillTP || isLongKillSL) closedKillPosSide = 'LONG'; else if (isShortKillTP || isShortKillSL) closedKillPosSide = 'SHORT';

    if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === symbol && closedKillPosSide) {
        addLog(`  [KILL ${isLongKillTP || isShortKillTP ? 'TP' : 'SL'}] Lệnh ${closedKillPosSide} ${TARGET_COIN_SYMBOL} đã khớp.`);
        const remainingPos = (closedKillPosSide === 'LONG') ? currentShortPosition : currentLongPosition;
        const closedPos = (closedKillPosSide === 'LONG') ? currentLongPosition : currentShortPosition;

        if (remainingPos?.quantity > 0 && remainingPos.initialMargin > 0) {
            try {
                const pData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPos.symbol });
                const rEx = pData.find(p => p.symbol === remainingPos.symbol && p.positionSide === remainingPos.side);
                if (rEx) remainingPos.unrealizedPnl = parseFloat(rEx.unRealizedProfit);
            } catch (e) {
                addLog(`  Lỗi lấy PNL lệnh còn lại: ${e.message}`);
            }

            if (closedPos && (isLongKillSL || isShortKillSL) && closedPos.currentTPId) {
                try {
                    await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: closedPos.symbol, orderId: closedPos.currentTPId });
                    addLog(`  Đã hủy TP ${closedPos.currentTPId} của lệnh ${closedPos.side} vừa SL.`);
                } catch (e) {
                    if (e.code !== -2011) addLog(`  Warn: Lỗi hủy TP ${closedPos.currentTPId} của lệnh ${closedPos.side} vừa SL: ${e.msg}`);
                }
            }
             if (closedPos && (isLongKillTP || isShortKillTP) && closedPos.currentSLId) {
                try {
                    await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: closedPos.symbol, orderId: closedPos.currentSLId });
                    addLog(`  Đã hủy SL ${closedPos.currentSLId} của lệnh ${closedPos.side} vừa TP.`);
                } catch (e) {
                    if (e.code !== -2011) addLog(`  Warn: Lỗi hủy SL ${closedPos.currentSLId} của lệnh ${closedPos.side} vừa TP: ${e.msg}`);
                }
            }


            if (realizedPnl >= 0) {
                addLog(`  Lệnh ${closedKillPosSide} lời. Đóng nốt ${remainingPos.side}.`);
                if (remainingPos.currentTPId) try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: remainingPos.symbol, orderId: remainingPos.currentTPId }); remainingPos.currentTPId = null; } catch(e){ if(e.code !== -2011) addLog(`Warn: Lỗi hủy TP ${remainingPos.currentTPId} của ${remainingPos.side}`);}
                if (remainingPos.currentSLId) try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: remainingPos.symbol, orderId: remainingPos.currentSLId }); remainingPos.currentSLId = null; } catch(e){ if(e.code !== -2011) addLog(`Warn: Lỗi hủy SL ${remainingPos.currentSLId} của ${remainingPos.side}`);}
                await sleep(300);
                await closePosition(remainingPos.symbol, `Lãi KILL (${closedKillPosSide}) chốt, đóng nốt`, remainingPos.side);
            } else {
                addLog(`  Lệnh ${closedKillPosSide} lỗ. ${remainingPos.side} tiếp tục.`);
                remainingPos.nextPartialCloseLossIndex = 0;
                remainingPos.hasAdjustedSLToSpecificLevel = {};
                remainingPos.lastPnlBaseResetTime = Date.now();
                await sleep(300);
                if (!await setTPAndSLForPosition(remainingPos, true)) {
                    addLog(`  Lỗi đặt lại TP/SL cho ${remainingPos.side}. Đóng.`);
                    await closePosition(remainingPos.symbol, "Lỗi đặt lại TP/SL", remainingPos.side);
                }
            }
        }

        if (closedPos) {
            if (closedKillPosSide === 'LONG') currentLongPosition = null;
            else if (closedKillPosSide === 'SHORT') currentShortPosition = null;
        }

        if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(symbol);
    } else if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === symbol && clientOrderId && (clientOrderId.includes("-PARTIAL-") || clientOrderId.includes("-ADD-") || clientOrderId.includes("CLOSE-"))) {
        addLog(`  Lệnh ${clientOrderId} đã khớp.`); await sleep(1000);
        try {
            const positionsAfter = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            if (currentLongPosition) { const lp = positionsAfter.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='LONG'); currentLongPosition.quantity = lp?Math.abs(parseFloat(lp.positionAmt)):0; if(currentLongPosition.quantity===0)currentLongPosition=null; else currentLongPosition.entryPrice=parseFloat(lp.entryPrice);}
            if (currentShortPosition) { const sp = positionsAfter.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='SHORT'); currentShortPosition.quantity = sp?Math.abs(parseFloat(sp.positionAmt)):0; if(currentShortPosition.quantity===0)currentShortPosition=null; else currentShortPosition.entryPrice=parseFloat(sp.entryPrice);}
            if(!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
        } catch (e) { addLog(`  Lỗi cập nhật KL sau lệnh ${clientOrderId}: ${e.msg || e.message}`); }
    }
    if(!wasProcessing && orderStatus !== 'NEW' && orderStatus !== 'PARTIALLY_FILLED') isProcessingTrade = false;
}

async function cleanupAndResetCycle(symbolToCleanup, isSwitchingCoin = false) {
    if (!symbolToCleanup && TARGET_COIN_SYMBOL) symbolToCleanup = TARGET_COIN_SYMBOL;
    if (!symbolToCleanup) { addLog("Không có symbol để cleanup."); return; }
    addLog(`Chu kỳ cho ${symbolToCleanup} kết thúc. Dọn dẹp...`);
    if (symbolToCleanup === TARGET_COIN_SYMBOL || !TARGET_COIN_SYMBOL) {
        currentLongPosition = null; currentShortPosition = null;
        sidewaysGrid.isActive = false;
        if (sidewaysGrid.isClearingForSwitch) { addLog("  Đang dọn lưới/chuyển mode, không schedule lại từ cleanup."); return; }
    }
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; addLog("  Đã xóa interval kiểm tra vị thế."); }
    await cancelAllOpenOrdersForSymbol(symbolToCleanup);
    await checkAndHandleRemainingPosition(symbolToCleanup);
    isOpeningInitialPair = false;
    if (botRunning && !sidewaysGrid.isClearingForSwitch) {
        const delay = isSwitchingCoin ? COIN_SWITCH_DELAY_MS : 1000;
        addLog(`  Lên lịch cho chu kỳ tiếp theo sau ${delay/1000} giây (sau cleanup${isSwitchingCoin ? ' đổi coin':''}).`);
        scheduleNextMainCycle(delay);
    }
}

async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.';
    if (!API_KEY || !SECRET_KEY || API_KEY === 'YOUR_BINANCE_API_KEY') return 'Lỗi: Thiếu API_KEY hoặc SECRET_KEY hợp lệ.';
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime(); await getExchangeInfo(); await fetchAndCacheTopCoinsFromVPS1();
        TARGET_COIN_SYMBOL = await selectTargetCoin(true);
        if (!TARGET_COIN_SYMBOL) throw new Error("Không thể chọn coin mục tiêu ban đầu từ VPS1.");
        addLog(`Coin mục tiêu ban đầu: ${TARGET_COIN_SYMBOL}`);

        totalProfit = 0; totalLoss = 0; netPNL = 0; cumulativeRealizedPnlSinceStart = 0;
        currentLongPosition = null; currentShortPosition = null;
        isProcessingTrade = false; consecutiveApiErrors = 0; isOpeningInitialPair = false;
        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForSwitch: false, switchDelayTimeout: null };
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey); else {
            addLog("Không lấy được listenKey ban đầu. Bot không thể bắt đầu User Stream.");
            throw new Error("Không thể lấy listenKey ban đầu.");
        }
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        scheduleNextMainCycle(1000); return 'Bot khởi động thành công.';
    } catch (err) {
        const errorMsg = err.msg || err.message || 'Lỗi không xác định khi khởi động'; addLog(`Lỗi nghiêm trọng khi khởi động: ${errorMsg}`);
        botRunning = false;
        if (!(err instanceof CriticalApiError && (errorMsg.includes("API_KEY") || errorMsg.includes("SECRET_KEY") || errorMsg.includes("listenKey")) ) && !retryBotTimeout) {
            addLog(`Thử khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => { retryBotTimeout = null; await startBotLogicInternal(); }, ERROR_RETRY_DELAY_MS);
        } return `Lỗi khởi động: ${errorMsg}.`;
    }
}
async function stopBotLogicInternal(reason = "Lệnh dừng thủ công") {
    if (!botRunning && !retryBotTimeout) return 'Bot không chạy hoặc không đang retry.';
    addLog(`--- Dừng Bot (Lý do: ${reason}) ---`);
    const wasBotRunningState = botRunning;
    botRunning = false;
    isOpeningInitialPair = false;
    if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout); nextScheduledCycleTimeout = null;
    if (positionCheckInterval) clearInterval(positionCheckInterval); positionCheckInterval = null;
    if (sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout); sidewaysGrid.switchDelayTimeout = null;
    sidewaysGrid.isClearingForSwitch = false;

    const savedIsProcessingTrade = isProcessingTrade;
    isProcessingTrade = false;

    if (sidewaysGrid.isActive) await closeAllSidewaysPositionsAndOrders(`Bot dừng: ${reason}`).catch(e => addLog(`Lỗi đóng lệnh lưới: ${e.message}`));
    sidewaysGrid.isActive = false; sidewaysGrid.activeGridPositions = [];
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
    if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; addLog("Market Stream đã đóng."); }
    if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.terminate(); userDataWs = null; addLog("User Stream đã đóng."); }
    if (listenKey) await callSignedAPI('/fapi/v1/listenKey', 'DELETE', { listenKey }).then(()=>addLog("ListenKey đã xóa.")).catch(e=>addLog(`Lỗi xóa listenKey: ${e.msg||e.message}`));
    listenKey = null;
    if (currentLongPosition && TARGET_COIN_SYMBOL) await closePosition(TARGET_COIN_SYMBOL, `Bot dừng: ${reason}`, "LONG").catch(e => addLog(`Lỗi đóng Long: ${e.message}`));
    if (currentShortPosition && TARGET_COIN_SYMBOL) await closePosition(TARGET_COIN_SYMBOL, `Bot dừng: ${reason}`, "SHORT").catch(e => addLog(`Lỗi đóng Short: ${e.message}`));

    isProcessingTrade = savedIsProcessingTrade && wasBotRunningState;
    if (!wasBotRunningState) isProcessingTrade = false;

    if (TARGET_COIN_SYMBOL) await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
    currentLongPosition = null; currentShortPosition = null;
    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; addLog("Đã hủy retry khởi động (nếu có)."); }
    addLog('--- Bot đã dừng ---'); return 'Bot đã dừng.';
}
async function checkAndHandleRemainingPosition(symbol) {
    if (!symbol) return; addLog(`Kiểm tra vị thế sót cho ${symbol}...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remaining = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remaining.length > 0) {
            addLog(`Tìm thấy ${remaining.length} vị thế sót cho ${symbol}. Đang đóng...`);
            await cancelAllOpenOrdersForSymbol(symbol); await sleep(500);
            for (const pos of remaining) { await closePosition(pos.symbol, `Dọn dẹp vị thế sót`, parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT'); await sleep(1000); }
            addLog(`Hoàn tất đóng vị thế sót cho ${symbol}.`);
        } else { addLog(`Không có vị thế sót nào cho ${symbol}.`); }
    } catch (error) { addLog(`Lỗi dọn vị thế sót cho ${symbol}: ${error.msg || error.message}`); if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi dọn vị thế sót ${symbol}`); }
}
function scheduleNextMainCycle(delayMs = 7000) {
    if (!botRunning) return; if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = setTimeout(async () => {
        if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForSwitch && !isOpeningInitialPair) {
            try { await runTradingLogic(); }
            catch (e) {
                addLog(`Lỗi chu kỳ chính runTradingLogic (${TARGET_COIN_SYMBOL||'N/A'}): ${e.msg||e.message} ${e.stack?.substring(0,300)||''}`);
                if (e instanceof CriticalApiError) {
                    await stopBotLogicInternal(`Lỗi CriticalApiError trong chu kỳ chính: ${e.message}`);
                } else if (botRunning) {
                    scheduleNextMainCycle(15000);
                }
            }
        } else if (botRunning) { scheduleNextMainCycle(delayMs); }
    }, delayMs);
}
async function getListenKey() { if (!API_KEY || !SECRET_KEY) {addLog("Thiếu API key/secret."); return null;} try { const r = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog("Lấy ListenKey thành công."); return r.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.msg || e.message}`); return null; } }
async function keepAliveListenKey(key) {
    if (!key) return;
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: key });
        addLog("Gia hạn ListenKey.");
    } catch (e) {
        addLog(`Lỗi gia hạn listenKey (${key}): ${e.msg || e.message}.`);
        if (botRunning && userDataWs) {
            userDataWs.terminate();
            userDataWs = null;
            const oldListenKey = listenKey;
            listenKey = null;
            addLog("User Stream đóng do lỗi gia hạn key. Thử lấy key mới và kết nối lại.");
            const newKey = await getListenKey();
            if (newKey) {
                listenKey = newKey;
                setupUserDataStream(newKey);
            } else {
                addLog("Không lấy được listenKey mới sau lỗi gia hạn. User Stream sẽ không hoạt động.");
                if (botRunning) await stopBotLogicInternal("Không thể gia hạn hoặc lấy listenKey mới cho User Stream.");
            }
        }
    }
}

function setupUserDataStream(key) {
    if (!key) { addLog("Không có listenKey cho User Stream."); return; }
    if (userDataWs && (userDataWs.readyState === WebSocket.OPEN || userDataWs.readyState === WebSocket.CONNECTING)) { userDataWs.removeAllListeners(); userDataWs.terminate(); userDataWs = null; }
    const url = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`; userDataWs = new WebSocket(url); addLog("Đang kết nối User Data Stream...");
    userDataWs.on('open', () => { addLog('User Data Stream đã kết nối.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(() => keepAliveListenKey(listenKey), 30 * 60 * 1000); });
    userDataWs.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(msg.o);
            } else if (msg.e === 'listenKeyExpired') {
                addLog("User Stream: ListenKey hết hạn.");
                if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
                listenKeyRefreshInterval = null;
                const newKey = await getListenKey();
                if (newKey) {
                    listenKey = newKey;
                    setupUserDataStream(newKey);
                } else {
                    addLog("Không lấy được key mới sau khi hết hạn. User Stream sẽ dừng.");
                    if(botRunning) await stopBotLogicInternal("ListenKey hết hạn và không thể lấy key mới.");
                }
            }
        } catch (e) { addLog('Lỗi xử lý User Data Stream: ' + e.message + `. Data: ${data.toString().substring(0,100)}`); }
    });
    userDataWs.on('error', (err) => {
        addLog('Lỗi User Data Stream: ' + err.message);
        if (botRunning && listenKey) {
             addLog("Thử kết nối lại User Stream sau lỗi...");
             if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.terminate(); userDataWs = null; }
             if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
             setTimeout(async () => {
                const newKey = await getListenKey();
                if (newKey) {
                    listenKey = newKey;
                    setupUserDataStream(newKey);
                } else {
                    addLog("Không lấy được listenKey mới sau lỗi User Stream. User Stream sẽ không hoạt động.");
                     if(botRunning) await stopBotLogicInternal("Lỗi User Stream và không thể lấy listenKey mới.");
                }
             }, 10000);
        }
    });
    userDataWs.on('close', async (code, reason) => { addLog(`User Data Stream đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}.`); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; if (botRunning && listenKey) { addLog("  Thử kết nối lại User Stream sau 5s..."); await sleep(5000); if(listenKey) setupUserDataStream(listenKey); else {const newKey = await getListenKey(); if(newKey){listenKey=newKey; setupUserDataStream(newKey);} else {addLog("  Không lấy được listenKey mới để kết nối lại User Stream."); if(botRunning) await stopBotLogicInternal("User Stream đóng và không thể lấy listenKey mới.");}} } });
}
function setupMarketDataStream(symbol) {
    if (!symbol) { addLog("Không có symbol cho Market Stream."); return; }
    if (marketWs && (marketWs.readyState === WebSocket.OPEN || marketWs.readyState === WebSocket.CONNECTING)) { const oldS = marketWs.url.split('/').pop().split('@')[0].toUpperCase(); if (oldS.toLowerCase() === symbol.toLowerCase()) { addLog(`Market stream ${symbol} đã chạy.`); return; } addLog(`Đóng Market Stream cũ ${oldS}...`); marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; }
    const streamName = `${symbol.toLowerCase()}@markPrice@1s`; const url = `${WS_BASE_URL}/ws/${streamName}`;
    marketWs = new WebSocket(url); addLog(`Đang kết nối Market Data Stream cho ${symbol} (${url})...`);
    marketWs.on('open', () => addLog(`Market Data Stream ${symbol} đã kết nối.`));
    marketWs.on('message', (data) => { try { const msg = JSON.parse(data.toString()); if (msg.e === 'markPriceUpdate' && msg.s === TARGET_COIN_SYMBOL) { currentMarketPrice = parseFloat(msg.p); if(currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice; if(currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice; } } catch (e) { addLog(`Lỗi xử lý Market Stream (${symbol}): ` + e.message + `. Data: ${data.toString().substring(0,100)}`); } });
    marketWs.on('error', (err) => {
        addLog(`Lỗi Market Data Stream (${symbol}): ` + err.message);
        if (botRunning && symbol === TARGET_COIN_SYMBOL) {
            addLog(`Thử kết nối lại Market Stream ${TARGET_COIN_SYMBOL} sau lỗi...`);
            if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; }
            setTimeout(() => setupMarketDataStream(TARGET_COIN_SYMBOL), 10000);
        }
    });
    marketWs.on('close', (code, reason) => { const closedS = marketWs && marketWs.url ? marketWs.url.split('/').pop().split('@')[0].toUpperCase() : symbol; addLog(`Market Stream (${closedS}) đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}.`); if (botRunning && closedS === TARGET_COIN_SYMBOL) { addLog(`Thử kết nối lại Market Stream ${TARGET_COIN_SYMBOL} sau 5s...`); setTimeout(() => setupMarketDataStream(TARGET_COIN_SYMBOL), 5000); } else if (botRunning && closedS !== TARGET_COIN_SYMBOL) addLog(`Market stream coin cũ ${closedS} đóng.`); });
}

const app = express(); app.use(express.json());
app.get('/', (req, res) => { const indexPath = path.join(__dirname, 'index.html'); if (fs.existsSync(indexPath)) res.sendFile(indexPath); else res.status(404).send("<h1>Bot Control Panel</h1><p>File index.html không tìm thấy trong thư mục gốc của bot.</p>"); });
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) {addLog(`Lỗi đọc log: ${err.message}`); return res.status(500).send('Lỗi đọc log.');} const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.type('text/plain').send(cleanData.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => {
    let pm2Status = "PM2 không lấy được."; try { const pm2List = await new Promise((resolve, reject) => exec('pm2 jlist', {timeout:3000}, (e,o,s)=>e?reject(s||e.message):resolve(o))); const procs = JSON.parse(pm2List); const botP = procs.find(p=>p.name===THIS_BOT_PM2_NAME||(p.pm2_env?.PORT&&parseInt(p.pm2_env.PORT)===WEB_SERVER_PORT)); if(botP)pm2Status=`PM2 ${botP.name}: ${botP.pm2_env.status.toUpperCase()} (R:${botP.pm2_env.restart_time},U:${Math.floor(botP.pm2_env.pm_uptime/(1000*60))}p)`; else pm2Status=`PM2 '${THIS_BOT_PM2_NAME}'(Port ${WEB_SERVER_PORT}) not found.`;}catch(err){pm2Status=`Lỗi PM2: ${err.message.substring(0,100)}.`}
    const currentCoinV1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1VolDisplay = currentCoinV1 ? Math.abs(currentCoinV1.changePercent).toFixed(2) + '%' : 'N/A';
    let statusMsg = `${pm2Status} | BOT: ${botRunning?'CHẠY':'DỪNG'}`; if(botStartTime&&botRunning)statusMsg+=` | Up Bot: ${Math.floor((Date.now()-botStartTime.getTime())/60000)}p`; statusMsg+=` | Coin: ${TARGET_COIN_SYMBOL||"N/A"} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | Mode: ${currentBotMode.toUpperCase()} (VPS1_Vol:${vps1VolDisplay})`; if(sidewaysGrid.isClearingForSwitch)statusMsg+=" (DỌN LƯỚI/CHUYỂN MODE)";
    let posText = ""; if (currentBotMode==='kill'&&(currentLongPosition||currentShortPosition)){posText=" | Kill: "; if(currentLongPosition){const pnlL=currentLongPosition.unrealizedPnl||0;posText+=`L(KL:${currentLongPosition.quantity.toFixed(currentLongPosition.quantityPrecision||2)} PNL:${pnlL.toFixed(1)} M${(currentLongPosition.nextPartialCloseLossIndex||0)+1}) `;} if(currentShortPosition){const pnlS=currentShortPosition.unrealizedPnl||0;posText+=`S(KL:${currentShortPosition.quantity.toFixed(currentShortPosition.quantityPrecision||2)} PNL:${pnlS.toFixed(1)} M${(currentShortPosition.nextPartialCloseLossIndex||0)+1})`;}} else if(currentBotMode==='sideways'&&sidewaysGrid.isActive){const det=TARGET_COIN_SYMBOL?await getSymbolDetails(TARGET_COIN_SYMBOL):null;const pp=det?det.pricePrecision:4;posText=` | Lưới: ${sidewaysGrid.activeGridPositions.length} lệnh. Anchor: ${sidewaysGrid.anchorPrice?.toFixed(pp)}. SLs: ${sidewaysGrid.sidewaysStats.slMatchedCount}, TPs: ${sidewaysGrid.sidewaysStats.tpMatchedCount}`;} else posText=" | Vị thế: --";
    statusMsg+=posText; statusMsg+=` | PNL Ròng (${TARGET_COIN_SYMBOL||'N/A'}): ${netPNL.toFixed(2)} (L:${totalProfit.toFixed(2)}, T:${totalLoss.toFixed(2)})`;
    let trueOverallPnlTemp = cumulativeRealizedPnlSinceStart;
    if (currentLongPosition?.unrealizedPnl) trueOverallPnlTemp += currentLongPosition.unrealizedPnl;
    if (currentShortPosition?.unrealizedPnl) trueOverallPnlTemp += currentShortPosition.unrealizedPnl;
    if (sidewaysGrid.isActive && TARGET_COIN_SYMBOL && currentMarketPrice) {
        sidewaysGrid.activeGridPositions.forEach(p => {
            if (p.symbol === TARGET_COIN_SYMBOL && p.entryPrice && p.quantity) {
                trueOverallPnlTemp += (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1);
            }
        });
    }
    statusMsg += ` | PNL BOT Tổng: ${trueOverallPnlTemp.toFixed(2)}`;
    res.type('text/plain').send(statusMsg);
});
app.get('/api/bot_stats', async (req, res) => {
    let killPositionsData = [];
    if(currentBotMode === 'kill'){
        for(const p of [currentLongPosition, currentShortPosition]){
            if(p){
                const d = TARGET_COIN_SYMBOL ? await getSymbolDetails(p.symbol) : null;
                const pp = d ? d.pricePrecision : 2;
                const qp = d ? d.quantityPrecision : 3;
                const pnl = p.unrealizedPnl || 0;
                killPositionsData.push({
                    type: 'kill',
                    side: p.side,
                    entry: p.entryPrice?.toFixed(pp),
                    qty: p.quantity?.toFixed(qp),
                    pnl: pnl.toFixed(2),
                    curPrice: p.currentPrice?.toFixed(pp),
                    initQty: p.initialQuantity?.toFixed(qp),
                    closedLossQty: p.closedLossAmount?.toFixed(qp),
                    pairEntry: p.pairEntryPrice?.toFixed(pp),
                    mocIdx: (p.nextPartialCloseLossIndex !== undefined ? p.nextPartialCloseLossIndex : -1) + 1,
                    tpId: p.currentTPId,
                    slId: p.currentSLId
                });
            }
        }
    }

    let gridPositionsData = [];
    if(sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0){
        for(const p of sidewaysGrid.activeGridPositions){
            const d = TARGET_COIN_SYMBOL ? await getSymbolDetails(p.symbol) : null;
            const ppG = d ? d.pricePrecision : 4;
            const qpG = d ? d.quantityPrecision : 4;
            let pnlU = 0;
            if(currentMarketPrice && p.entryPrice && p.quantity && p.symbol === TARGET_COIN_SYMBOL) {
                pnlU = (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1);
            }
            gridPositionsData.push({
                type: 'grid',
                id: p.id,
                side: p.side,
                entry: p.entryPrice?.toFixed(ppG),
                qty: p.quantity?.toFixed(qpG),
                curPrice: currentMarketPrice?.toFixed(ppG),
                pnl: pnlU.toFixed(2),
                originalAnchor: p.originalAnchorPrice?.toFixed(ppG),
                step: p.stepIndex,
                tpId: p.tpOrderId,
                slId: p.slOrderId
            });
        }
    }
    const cDet = TARGET_COIN_SYMBOL ? await getSymbolDetails(TARGET_COIN_SYMBOL) : null;
    const cPP = cDet ? cDet.pricePrecision : 4;
    const currentCoinV1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1VolDisp = currentCoinV1 ? Math.abs(currentCoinV1.changePercent).toFixed(2) + '%' : 'N/A';

    let currentCycleOverallPNLCalculated = parseFloat(totalProfit) - parseFloat(totalLoss);
    killPositionsData.forEach(p => { currentCycleOverallPNLCalculated += parseFloat(p.pnl) || 0; });
    gridPositionsData.forEach(p => { currentCycleOverallPNLCalculated += parseFloat(p.pnl) || 0; });

    let trueOverallPnlSinceStartCalculated = cumulativeRealizedPnlSinceStart;
    killPositionsData.forEach(p => { trueOverallPnlSinceStartCalculated += parseFloat(p.pnl) || 0; });
    gridPositionsData.forEach(p => { trueOverallPnlSinceStartCalculated += parseFloat(p.pnl) || 0; });


    res.json({
        success: true,
        data: {
            botRunning: botRunning,
            botStartTime: botStartTime ? formatTimeUTC7(botStartTime) : "N/A",
            currentMode: currentBotMode.toUpperCase(),
            vps1Volatility: vps1VolDisp,
            totalProfit: totalProfit.toFixed(2),
            totalLoss: totalLoss.toFixed(2),
            netPNL: netPNL.toFixed(2),
            currentCycleOverallPNL: currentCycleOverallPNLCalculated.toFixed(2),
            trueOverallPnlSinceStart: trueOverallPnlSinceStartCalculated.toFixed(2),
            currentCoin: TARGET_COIN_SYMBOL || "N/A",
            initialInvestment: INITIAL_INVESTMENT_AMOUNT,
            overallTakeProfit: overallTakeProfit,
            overallStopLoss: overallStopLoss,
            killPositions: killPositionsData,
            sidewaysGridInfo: {
                isActive: sidewaysGrid.isActive,
                isClearingForSwitch: sidewaysGrid.isClearingForSwitch,
                anchorPrice: sidewaysGrid.anchorPrice?.toFixed(cPP),
                upperLimit: sidewaysGrid.gridUpperLimit?.toFixed(cPP),
                lowerLimit: sidewaysGrid.gridLowerLimit?.toFixed(cPP),
                stats: {
                    tpMatchedCount: sidewaysGrid.sidewaysStats.tpMatchedCount,
                    slMatchedCount: sidewaysGrid.sidewaysStats.slMatchedCount
                },
                activePositions: gridPositionsData
            },
            vps1DataUrl: VPS1_DATA_URL,
            currentMarketPrice: currentMarketPrice?.toFixed(cPP)
        }
    });
});
app.post('/api/configure', (req, res) => {
    const { initialAmount, overallTakeProfit: newOverallTP, overallStopLoss: newOverallSL } = req.body;
    let changesMade = []; let errors = [];

    if (initialAmount !== undefined) {
        const newIA = parseFloat(initialAmount);
        if (!isNaN(newIA) && newIA > 0) {
            if (newIA !== INITIAL_INVESTMENT_AMOUNT) {
                INITIAL_INVESTMENT_AMOUNT = newIA;
                changesMade.push(`Vốn Kill đổi thành ${INITIAL_INVESTMENT_AMOUNT}.`);
            }
        } else {
            errors.push("Vốn không hợp lệ.");
        }
    }

    if (newOverallTP !== undefined) {
        const tpVal = parseFloat(newOverallTP);
        if (!isNaN(tpVal) && tpVal >= 0) {
            if (tpVal !== overallTakeProfit) {
                overallTakeProfit = tpVal;
                changesMade.push(`Chốt lời tổng đổi thành ${overallTakeProfit > 0 ? overallTakeProfit : 'không đặt'}.`);
            }
        } else {
            errors.push("Chốt lời tổng không hợp lệ.");
        }
    }

    if (newOverallSL !== undefined) {
        const slVal = parseFloat(newOverallSL);
        if (!isNaN(slVal) && slVal <= 0) {
             if (slVal !== overallStopLoss) {
                overallStopLoss = slVal;
                changesMade.push(`Cắt lỗ tổng đổi thành ${overallStopLoss < 0 ? overallStopLoss : 'không đặt'}.`);
            }
        } else {
            errors.push("Cắt lỗ tổng không hợp lệ (phải là số âm hoặc 0).");
        }
    }

    let msg; if (errors.length > 0) { msg = "Lỗi cấu hình: " + errors.join(" "); if (changesMade.length > 0) msg += " Thay đổi hợp lệ đã áp dụng: " + changesMade.join(" "); addLog(`Cấu hình API thất bại: ${msg}`); res.status(400).json({ success: false, message: msg }); } else if (changesMade.length > 0) { msg = "Cấu hình cập nhật: " + changesMade.join(" "); addLog(msg); res.json({ success: true, message: msg }); } else { msg = "Không có thay đổi cấu hình."; res.json({ success: true, message: msg }); }
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', async (req, res) => res.send(await stopBotLogicInternal("Lệnh dừng từ API /stop_bot_logic")));

(async () => {
    try {
        if (!API_KEY || !SECRET_KEY || API_KEY === 'YOUR_BINANCE_API_KEY') addLog("LỖI NGHIÊM TRỌNG: API_KEY/SECRET_KEY chưa cấu hình!");
        await syncServerTime(); await getExchangeInfo(); await fetchAndCacheTopCoinsFromVPS1();
        const server = app.listen(WEB_SERVER_PORT, '0.0.0.0', () => { addLog(`Web server Bot Client (HTTP) chạy tại http://<YOUR_IP>:${WEB_SERVER_PORT}`); addLog(`Log file: ${CUSTOM_LOG_FILE}`); });
        server.on('error', (e) => { addLog(`Lỗi khởi động server: ${e.message}`); process.exit(1); });
    } catch (e) {
        addLog(`LỖI KHỞI TẠO SERVER/BINANCE API: ${e.msg || e.message}. Bot có thể không hoạt động.`);
        try { const srv = app.listen(WEB_SERVER_PORT, '0.0.0.0', () => addLog(`Web server (CHẾ ĐỘ LỖI - HTTP) chạy tại http://<YOUR_IP>:${WEB_SERVER_PORT}`)); srv.on('error', (ef) => { addLog(`Lỗi khởi động server (fallback): ${ef.message}`); process.exit(1); }); }
        catch (efinal) { addLog(`Không thể khởi động server: ${efinal.message}`); process.exit(1); }
    }
})();

process.on('unhandledRejection', async (reason, promise) => {
    const reasonMsg = reason?.stack || reason?.message || reason?.toString() || "Unknown unhandled rejection";
    addLog(`Unhandled Rejection at: ${promise}, reason: ${reasonMsg}`);
    if (botRunning) {
        await stopBotLogicInternal(`Unhandled Rejection: ${reasonMsg.substring(0,100)}`);
    }
});
process.on('uncaughtException', async (error) => {
    const errorMsg = error.stack || error.message || error.toString() || "Unknown uncaught exception";
    addLog(`Uncaught Exception: ${errorMsg}`);
    if (botRunning) {
        await stopBotLogicInternal(`Uncaught Exception: ${errorMsg.substring(0,100)}`);
    }
    process.exit(1);
});
