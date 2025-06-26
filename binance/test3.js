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

const VPS1_DATA_URL = 'http://34.142.248.96:9000/'; // <<<<----- CẬP NHẬT ĐỊA CHỈ VPS1!
const MIN_CANDLES_FOR_SELECTION = 55;
const VOLATILITY_SWITCH_THRESHOLD_PERCENT = 5.0;
const MIN_VOLATILITY_DIFFERENCE_TO_SWITCH = 3.0;
const OVERALL_VOLATILITY_THRESHOLD_VPS1 = 5.0;
const MIN_LEVERAGE_TO_TRADE = 50;
const PARTIAL_CLOSE_INDEX_5 = 4;
const PARTIAL_CLOSE_INDEX_8 = 7;

const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

const WEB_SERVER_PORT = 9001;
const THIS_BOT_PM2_NAME = 'test3'; // Thay đổi tên để pm2 nhận diện là bản mới
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
const KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS = 30 * 1000;

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
let INITIAL_INVESTMENT_AMOUNT = 0.12;
let TARGET_COIN_SYMBOL = null;
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;
let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null;
let consecutiveApiErrors = 0;
let vps1DataCache = [];
let sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
let lastCoinSwitchCheckTime = 0;

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
    else if (method === 'POST' || method === 'PUT') { requestPath = fullEndpointPath; requestBody = `${queryString}&signature=${signature}`; headers['Content-Type'] = 'application/x-www-form-urlencoded';}
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
async function fetchAndCacheTopCoinsFromVPS1() {
    const fullUrl = VPS1_DATA_URL; addLog(`Lấy dữ liệu VPS1 & cache: ${fullUrl}`); let rawDataForDebug = '';
    try { const rawData = await makeHttpRequest('GET', fullUrl); rawDataForDebug = rawData; const response = JSON.parse(rawData);
        if (response && response.status && Array.isArray(response.data)) {
            if (response.status === "running_data_available") { const filtered = response.data.filter(c => c.symbol && typeof c.changePercent === 'number' && c.candles >= MIN_CANDLES_FOR_SELECTION); vps1DataCache = [...filtered]; addLog(`VPS1 data cached. ${filtered.length} coins (status: ${response.status}).`); return [...filtered]; }
            else if (response.status === "error_binance_symbols" || response.status.startsWith("error")) { addLog(`VPS1 error (status: ${response.status}): ${response.message||'Lỗi VPS1'}. Dùng cache cũ (${vps1DataCache.length} coins).`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
            else { addLog(`VPS1 preparing (status: ${response.status}): ${response.message||'Chưa có message'}. Dùng cache cũ (${vps1DataCache.length} coins).`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
        } else { addLog(`Lỗi định dạng VPS1. Status: ${response?.status}. Dùng cache cũ (${vps1DataCache.length} coins). Raw: ${rawData.substring(0,200)}`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
    } catch (error) { let errMsg = `Lỗi lấy/phân tích VPS1 (${fullUrl}): ${error.code||'ERR'} - ${error.msg||error.message}.`; if(error.responseBody) errMsg+=` Body: ${error.responseBody.substring(0,100)}`; else if(error instanceof SyntaxError && error.message.includes("JSON")) errMsg+=` Lỗi parse JSON. Raw: ${rawDataForDebug.substring(0,100)}`; addLog(errMsg + `. Dùng cache cũ (${vps1DataCache.length} coins).`); return vps1DataCache.length > 0 ? [...vps1DataCache] : []; }
}
function getCurrentCoinVPS1Data(symbol) { if (!symbol || !vps1DataCache || vps1DataCache.length === 0) return null; return vps1DataCache.find(c => c.symbol === symbol); }
async function getLeverageBracketForSymbol(symbol) { if(!symbol) return 20; try { const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol }); const b = r.find(i => i.symbol === symbol)?.brackets[0]; return b ? parseInt(b.initialLeverage) : 20; } catch (e) { addLog(`Lỗi lấy lev bracket ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError) await stopBotLogicInternal(); return 20; } }
async function checkExistingPosition(symbol) { if (!symbol) return false; try { const pos = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }); return pos.some(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0); } catch (e) { if (e.code === -4003 && e.msg?.toLowerCase().includes("invalid symbol")) return false; addLog(`Lỗi check vị thế ${symbol}: ${e.msg||e.message}. Coi như có.`); return true; } }
async function selectTargetCoin(isInitialSelection = false) {
    addLog("Chọn coin từ VPS1 (MaxLev >= " + MIN_LEVERAGE_TO_TRADE + "x)..."); const topCoinsAll = await fetchAndCacheTopCoinsFromVPS1();
    if (!topCoinsAll || topCoinsAll.length === 0) { addLog("Không có coin từ VPS1/cache."); return null; }
    const eligibleCoins = [];
    for (const coin of topCoinsAll) { const maxLev = await getLeverageBracketForSymbol(coin.symbol); await sleep(150); if (maxLev >= MIN_LEVERAGE_TO_TRADE) eligibleCoins.push({...coin, maxLeverageBinance: maxLev }); else addLog(`  Coin ${coin.symbol} loại do maxLev ${maxLev}x < ${MIN_LEVERAGE_TO_TRADE}x.`); }
    if (eligibleCoins.length === 0) { addLog("Không coin nào đáp ứng đòn bẩy."); return null; }
    eligibleCoins.sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    addLog(`Có ${eligibleCoins.length} coin tiềm năng (đã lọc đòn bẩy). Kiểm tra vị thế...`);
    for (let i = 0; i < eligibleCoins.length; i++) {
        const coin = eligibleCoins[i]; addLog(`Kiểm tra coin #${i+1}: ${coin.symbol} (Vol VPS1: ${coin.changePercent}%, MaxLev: ${coin.maxLeverageBinance}x)`);
        if (TARGET_COIN_SYMBOL && coin.symbol === TARGET_COIN_SYMBOL && (currentLongPosition || currentShortPosition || sidewaysGrid.isActive)) { addLog(`  ${coin.symbol} là coin hiện tại. Bỏ qua.`); continue; }
        const hasPos = await checkExistingPosition(coin.symbol); await sleep(200);
        if (!hasPos) { addLog(`Đã chọn ${coin.symbol} (Vol VPS1: ${coin.changePercent}%, MaxLev: ${coin.maxLeverageBinance}x).`); return coin.symbol; }
        else { addLog(`  Đã có vị thế ${coin.symbol}. Bỏ qua.`); }
    } addLog(isInitialSelection ? "Tất cả coin đủ điều kiện đã có vị thế. Không chọn coin BAN ĐẦU." : "Tất cả coin đủ điều kiện đã có vị thế. Không chọn coin MỚI."); return null;
}
async function getHourlyVolatilityForLog(symbol) { if (!symbol) return 0; try { const klines = await callPublicAPI('/fapi/v1/klines', { symbol, interval: '1h', limit: 2 }); if (klines && klines.length > 0) { const c = klines.length > 1 ? klines[0] : klines[0]; const h = parseFloat(c[2]); const l = parseFloat(c[3]); if (l > 0) return ((h - l) / l) * 100; } return 0; } catch (e) { return 0; } }
async function syncServerTime() { try { const d = await callPublicAPI('/fapi/v1/time'); serverTimeOffset = d.serverTime - Date.now(); addLog(`Đồng bộ thời gian server: Offset ${serverTimeOffset}ms`); } catch (e) { addLog(`Lỗi đồng bộ thời gian: ${e.msg || e.message}`); if (e instanceof CriticalApiError) { await stopBotLogicInternal(); throw e; }} }
async function setLeverage(symbol, leverage) { if(!symbol) return false; try { await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage }); addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`); return true; } catch (e) { addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError) await stopBotLogicInternal(); return false; } }
async function getExchangeInfo() { if (exchangeInfoCache) return exchangeInfoCache; try { const d = await callPublicAPI('/fapi/v1/exchangeInfo'); exchangeInfoCache = {}; d.symbols.forEach(s => { const pF = s.filters.find(f=>f.filterType==='PRICE_FILTER'); const lF = s.filters.find(f=>f.filterType==='LOT_SIZE'); const mF = s.filters.find(f=>f.filterType==='MIN_NOTIONAL'); exchangeInfoCache[s.symbol] = { pricePrecision:s.pricePrecision, quantityPrecision:s.quantityPrecision, tickSize:parseFloat(pF?.tickSize || 1e-8), stepSize:parseFloat(lF?.stepSize || 1e-8), minNotional:parseFloat(mF?.notional || 0.1) }; }); addLog("Lấy Exchange Info."); return exchangeInfoCache; } catch (e) { addLog(`Lỗi lấy Exchange Info: ${e.msg||e.message}`); if (e instanceof CriticalApiError) await stopBotLogicInternal(); throw e; } }
async function getSymbolDetails(symbol) { if(!symbol) return null; const info = await getExchangeInfo(); if (!info) return null; const details = info[symbol]; if (!details) { addLog(`Không tìm thấy chi tiết ${symbol}. Thử làm mới.`); exchangeInfoCache=null; const fresh=await getExchangeInfo(); return fresh?.[symbol]||null;} return details;}
async function getCurrentPrice(symbol) { if(!symbol) return null; try { const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol }); return parseFloat(d.price); } catch (e) { addLog(`Lỗi lấy giá ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError) await stopBotLogicInternal(); return null; } }

async function cancelAllOpenOrdersForSymbol(symbol) {
    if (!symbol) return; addLog(`Hủy TẤT CẢ lệnh chờ ${symbol}...`);
    try { const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol }); if (!openOrders || openOrders.length === 0) { addLog(`Không lệnh chờ ${symbol}.`); return; } addLog(`Tìm thấy ${openOrders.length} lệnh chờ ${symbol}. Đang hủy...`);
        for (const order of openOrders) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol, orderId:order.orderId, origClientOrderId:order.clientOrderId }); addLog(`  Đã hủy lệnh ${order.orderId} (ClientID: ${order.clientOrderId}).`); await sleep(100); } catch (innerErr) { if (innerErr.code!==-2011) addLog(`  Lỗi hủy lệnh ${order.orderId}: ${innerErr.msg||innerErr.message}`); else addLog(`  Lệnh ${order.orderId} có thể đã xử lý.`); if (innerErr instanceof CriticalApiError) await stopBotLogicInternal(); }} addLog(`Hoàn tất hủy lệnh chờ ${symbol}.`);
    } catch (e) { if (e.code!==-2011) addLog(`Lỗi lấy DS lệnh chờ để hủy ${symbol}: ${e.msg||e.message}`); if (e instanceof CriticalApiError) await stopBotLogicInternal(); }
}
async function closePosition(symbol, reason, positionSideToClose) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSideToClose || isProcessingTrade) { if(isProcessingTrade) addLog(`closePosition(${symbol}) bỏ qua do isProcessingTrade.`); return false; }
    isProcessingTrade = true; addLog(`Đóng ${positionSideToClose} ${symbol} (Lý do: ${reason})...`);
    let errOccurred = null; let success = false;
    try { const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol }); const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === positionSideToClose && parseFloat(p.positionAmt) !== 0);
        if (posOnEx) { const qty = Math.abs(parseFloat(posOnEx.positionAmt)); if (qty === 0) success = false; else { const sideOrder = (positionSideToClose === 'LONG')?'SELL':'BUY'; await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side:sideOrder, positionSide:positionSideToClose, type:'MARKET', quantity:qty, newClientOrderId:`CLOSE-${positionSideToClose[0]}-${Date.now()}` }); addLog(`Đã gửi MARKET đóng ${qty} ${positionSideToClose} ${symbol}.`); if (positionSideToClose==='LONG'&¤tLongPosition)currentLongPosition.quantity=0; else if(positionSideToClose==='SHORT'&¤tShortPosition)currentShortPosition.quantity=0; success=true; }}
        else { addLog(`Không tìm thấy vị thế ${positionSideToClose} ${symbol}.`); success = false;}
    } catch (err) { errOccurred = err; addLog(`Lỗi đóng ${positionSideToClose} ${symbol}: ${err.msg||err.message}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); success = false;
    } finally { isProcessingTrade = false; return success; }
}
async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    if(!symbol) return null; addLog(`[${currentBotMode.toUpperCase()}] Mở ${tradeDirection} ${symbol} với ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try { const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`); if (maxLeverage < MIN_LEVERAGE_TO_TRADE) throw new Error(`Đòn bẩy ${maxLeverage}x < ${MIN_LEVERAGE_TO_TRADE}x.`); if (!await setLeverage(symbol, maxLeverage)) throw new Error(`Lỗi đặt đòn bẩy.`); await sleep(200);
        const priceCalc = entryPriceOverride || await getCurrentPrice(symbol); if (!priceCalc) throw new Error(`Lỗi lấy giá.`); let qty = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceCalc; qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision)); if (qty * priceCalc < details.minNotional) throw new Error(`Giá trị lệnh ${qty*priceCalc} USDT quá nhỏ (min: ${details.minNotional} USDT).`);
        const orderSide = (tradeDirection==='LONG')?'BUY':'SELL'; const orderRes = await callSignedAPI('/fapi/v1/order', 'POST', {symbol,side:orderSide,positionSide:tradeDirection,type:'MARKET',quantity:qty,newOrderRespType:'RESULT'}); const actualEntry=parseFloat(orderRes.avgPrice); const actualQty=parseFloat(orderRes.executedQty); if(actualQty===0)throw new Error(`Lệnh MARKET ${symbol} không khớp KL.`);
        addLog(`[${currentBotMode.toUpperCase()}] Đã MỞ ${tradeDirection} ${symbol} | KL: ${actualQty.toFixed(details.quantityPrecision)} | Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);
        return {symbol,quantity:actualQty,initialQuantity:actualQty,entryPrice:actualEntry,initialMargin:INITIAL_INVESTMENT_AMOUNT,side:tradeDirection,maxLeverageUsed:maxLeverage,pricePrecision:details.pricePrecision,quantityPrecision:details.quantityPrecision,closedLossAmount:0,nextPartialCloseLossIndex:0,pnlBaseForNextMoc:0,hasAdjustedSLToSpecificLevel:{},hasClosedAllLossPositionAtLastLevel:false,pairEntryPrice:priceCalc,currentTPId:null,currentSLId:null,unrealizedPnl:0,currentPrice:actualEntry};
    } catch (err) { addLog(`[${currentBotMode.toUpperCase()}] Lỗi mở ${tradeDirection} ${symbol}: ${err.msg||err.message}`); if(err instanceof CriticalApiError)await stopBotLogicInternal(); return null; }
}
async function setTPAndSLForPosition(position, isFullResetEvent = false) {
    if (!position || position.quantity <= 0 || !position.symbol) return false; const details = await getSymbolDetails(position.symbol); if(!details) {addLog(`[${currentBotMode.toUpperCase()}] Không có details cho ${position.symbol}.`); return false;}
    const { symbol, side, entryPrice, initialMargin, maxLeverageUsed, pricePrecision, initialQuantity, quantity, pnlBaseForNextMoc = 0 } = position;
    addLog(`[${currentBotMode.toUpperCase()}] Đặt/Reset TP/SL ${side} ${symbol} (Entry:${entryPrice.toFixed(pricePrecision)}, KL:${quantity.toFixed(position.quantityPrecision)}, PNLBase:${pnlBaseForNextMoc.toFixed(2)}%). MaxLev:${maxLeverageUsed}`);
    try { let TP_MULT,SL_MULT,steps=[]; if(maxLeverageUsed>=75){TP_MULT=10;SL_MULT=6;for(let i=1;i<=8;i++)steps.push(i*100);} else if(maxLeverageUsed>=MIN_LEVERAGE_TO_TRADE){TP_MULT=5;SL_MULT=3;for(let i=1;i<=8;i++)steps.push(i*50);} else {addLog(` Warn: MaxLev ${maxLeverageUsed}x < ${MIN_LEVERAGE_TO_TRADE}x. Dùng TP/SL cho >=50x.`);TP_MULT=5;SL_MULT=3;for(let i=1;i<=8;i++)steps.push(i*50);}
        const pnlBaseUSD=(initialMargin*pnlBaseForNextMoc)/100; const targetPnlTP_USD=(initialMargin*TP_MULT)+pnlBaseUSD; const targetPnlSL_USD=-(initialMargin*SL_MULT)+pnlBaseUSD;
        const priceChangeTP=targetPnlTP_USD/initialQuantity; const priceChangeSL=targetPnlSL_USD/initialQuantity;
        let tpPx=parseFloat((entryPrice+priceChangeTP).toFixed(pricePrecision)); let slPx=parseFloat((entryPrice+priceChangeSL).toFixed(pricePrecision)); const minTickGap=details.tickSize*5;
        if(side==='LONG'){tpPx=Math.max(tpPx,entryPrice+minTickGap);slPx=Math.min(slPx,entryPrice-minTickGap);tpPx=parseFloat(tpPx.toFixed(pricePrecision));slPx=parseFloat(slPx.toFixed(pricePrecision));if(slPx>=tpPx-minTickGap)slPx=parseFloat((tpPx-minTickGap).toFixed(pricePrecision));if(slPx<=0)slPx=parseFloat((entryPrice*0.90).toFixed(pricePrecision));if(tpPx<=entryPrice)tpPx=parseFloat((entryPrice+minTickGap).toFixed(pricePrecision));}
        else{tpPx=Math.min(tpPx,entryPrice-minTickGap);slPx=Math.max(slPx,entryPrice+minTickGap);tpPx=parseFloat(tpPx.toFixed(pricePrecision));slPx=parseFloat(slPx.toFixed(pricePrecision));if(tpPx>=slPx-minTickGap)tpPx=parseFloat((slPx-minTickGap).toFixed(pricePrecision));if(tpPx<=0)tpPx=parseFloat((entryPrice*0.90).toFixed(pricePrecision));if(slPx<=entryPrice)slPx=parseFloat((entryPrice+minTickGap).toFixed(pricePrecision));}
        const orderSideClose=(side==='LONG')?'SELL':'BUY'; if(quantity<=0)return false; addLog(`  ${side} ${symbol}: TP ${tpPx.toFixed(pricePrecision)}, SL ${slPx.toFixed(pricePrecision)} cho KL ${quantity.toFixed(details.quantityPrecision)}`);
        if(position.currentTPId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol,orderId:position.currentTPId});position.currentTPId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy TP cũ ${position.currentTPId}: ${e.msg}`);}
        if(position.currentSLId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol,orderId:position.currentSLId});position.currentSLId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy SL cũ ${position.currentSLId}: ${e.msg}`);}
        await sleep(300);
        const slOrdParams={symbol,side:orderSideClose,positionSide:side,type:'STOP_MARKET',stopPrice:slPx,quantity,timeInForce:'GTC',closePosition:'true',newClientOrderId:`${currentBotMode.toUpperCase()}-SL-${side[0]}${Date.now()}`};
        const tpOrdParams={symbol,side:orderSideClose,positionSide:side,type:'TAKE_PROFIT_MARKET',stopPrice:tpPx,quantity,timeInForce:'GTC',closePosition:'true',newClientOrderId:`${currentBotMode.toUpperCase()}-TP-${side[0]}${Date.now()}`};
        const slOrd=await callSignedAPI('/fapi/v1/order','POST',slOrdParams); const tpOrd=await callSignedAPI('/fapi/v1/order','POST',tpOrdParams);
        position.currentTPId=tpOrd.orderId;position.currentSLId=slOrd.orderId; addLog(`  Đã đặt TP ID: ${tpOrd.orderId}, SL ID: ${slOrd.orderId}.`);
        if(!position.partialCloseLossLevels||position.partialCloseLossLevels.length===0||isFullResetEvent)position.partialCloseLossLevels=steps;
        if(isFullResetEvent){position.nextPartialCloseLossIndex=0;position.hasAdjustedSLToSpecificLevel={};position.hasClosedAllLossPositionAtLastLevel=false;}
        if(typeof position.pnlBaseForNextMoc!=='number')position.pnlBaseForNextMoc=0; return true;
    }catch(err){addLog(`[${currentBotMode.toUpperCase()}] Lỗi đặt TP/SL ${side} ${symbol}: ${err.code||'ERR'} - ${err.msg||err.message}.`); if(err.code===-2021||(err.msg&&err.msg.includes("immediately trigger")))addLog("   Lỗi -2021: Giá stopPrice không hợp lệ."); if(err instanceof CriticalApiError)await stopBotLogicInternal(); return false;}
}
async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade || quantityToClose <=0 || !position.symbol) return false;
    isProcessingTrade = true; let errOccurred = null; let success = false;
    try { const details = await getSymbolDetails(position.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`); let qtyEff = Math.min(quantityToClose, position.quantity); qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qtyEff <= 0 || qtyEff * (position.currentPrice || position.entryPrice) < details.minNotional * 0.9) success = false;
        else { const sideOrder = (position.side === 'LONG') ? 'SELL' : 'BUY'; addLog(`[${currentBotMode.toUpperCase()}] Đóng từng phần ${qtyEff.toFixed(details.quantityPrecision)} ${position.side} ${position.symbol}.`); await callSignedAPI('/fapi/v1/order', 'POST', { symbol: position.symbol, side: sideOrder, positionSide: position.side, type: 'MARKET', quantity: qtyEff, newClientOrderId: `${currentBotMode.toUpperCase()}-PARTIAL-${position.side[0]}${Date.now()}` });
            position.closedLossAmount += qtyEff; position.quantity -= qtyEff; if (position.quantity < details.stepSize) position.quantity = 0; addLog(`  Đã gửi lệnh đóng. ${position.side} còn lại: ${position.quantity.toFixed(details.quantityPrecision)}`);
            if (position.quantity > 0) { if(position.currentTPId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol:position.symbol,orderId:position.currentTPId});position.currentTPId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy TP cũ ${position.currentTPId}: ${e.msg}`);} if(position.currentSLId)try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol:position.symbol,orderId:position.currentSLId});position.currentSLId=null;}catch(e){if(e.code!==-2011)addLog(` Warn: Lỗi hủy SL cũ ${position.currentSLId}: ${e.msg}`);} await sleep(500); await setTPAndSLForPosition(position, false); }
            else { addLog(`  ${position.side} ${position.symbol} đã đóng hết.`); if (position.side === 'LONG') currentLongPosition = null; else currentShortPosition = null; } success = true;
        }
    } catch (err) { errOccurred = err; addLog(`[${currentBotMode.toUpperCase()}] Lỗi đóng từng phần ${position.side}: ${err.msg || err.message}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); success = false;
    } finally { isProcessingTrade = false; return success; }
}
async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!positionToModify || quantityToAdd <= 0 || isProcessingTrade || !positionToModify.symbol) return false;
    isProcessingTrade = true; let errOccurred = null; let success = false;
    try { const details = await getSymbolDetails(positionToModify.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`); let qtyEff = quantityToAdd;
        if (reasonForAdd !== "kill_mode_reopen_closed_losing_pos" && reasonForAdd !== "mốc 5 quay đầu mở lại lỗ") { const currentQty = positionToModify.quantity; const maxAdd = positionToModify.initialQuantity - currentQty; if (maxAdd <= 0) { addLog(`[${currentBotMode.toUpperCase()} ADD] ${positionToModify.side} đã đủ KL.`); success = false; } else qtyEff = Math.min(qtyEff, maxAdd); }
        if (success !== false && qtyEff > 0) { qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
            if (qtyEff <= 0 || qtyEff * (positionToModify.currentPrice || positionToModify.entryPrice) < details.minNotional * 0.9) { success = false; }
            else { const sideOrder = (positionToModify.side === 'LONG')?'BUY':'SELL'; addLog(`[${currentBotMode.toUpperCase()} ADD] Mở thêm ${qtyEff.toFixed(details.quantityPrecision)} ${positionToModify.symbol} cho ${positionToModify.side} (Lý do: ${reasonForAdd}).`); await callSignedAPI('/fapi/v1/order','POST',{symbol:positionToModify.symbol,side:sideOrder,positionSide:positionToModify.side,type:'MARKET',quantity:qtyEff,newClientOrderId:`${currentBotMode.toUpperCase()}-ADD-${positionToModify.side[0]}${Date.now()}`});
                positionToModify.closedLossAmount -= qtyEff; if(positionToModify.closedLossAmount<0)positionToModify.closedLossAmount=0;
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500); const otherP = (positionToModify.side==='LONG')?currentShortPosition:currentLongPosition;
                if(reasonForAdd==="price_near_pair_entry_reopen"){positionToModify.pnlBaseForNextMoc=0;positionToModify.nextPartialCloseLossIndex=0;}
                else if(reasonForAdd==="kill_mode_reopen_closed_losing_pos"||reasonForAdd==="mốc 5 quay đầu mở lại lỗ"){positionToModify.pnlBaseForNextMoc=0;positionToModify.nextPartialCloseLossIndex=0;positionToModify.hasAdjustedSLToSpecificLevel={};positionToModify.hasClosedAllLossPositionAtLastLevel=false; if(otherP&&otherP.initialMargin>0){otherP.pnlBaseForNextMoc=(otherP.unrealizedPnl/otherP.initialMargin)*100;otherP.nextPartialCloseLossIndex=0;otherP.hasAdjustedSLToSpecificLevel={};addLog(`  Lệnh thắng ${otherP.side} cũng reset về Mốc 0, PNL base mới: ${otherP.pnlBaseForNextMoc.toFixed(2)}%`);}}
                const newPairEntry=await getCurrentPrice(TARGET_COIN_SYMBOL); if(newPairEntry){if(currentLongPosition)currentLongPosition.pairEntryPrice=newPairEntry;if(currentShortPosition)currentShortPosition.pairEntryPrice=newPairEntry;addLog(`  Cập nhật giá vào cặp mới: ${newPairEntry.toFixed(details.pricePrecision)}`);}
                await sleep(2000); const updatedPos=await callSignedAPI('/fapi/v2/positionRisk','GET',{symbol:TARGET_COIN_SYMBOL});
                if(currentLongPosition){const lpEx=updatedPos.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='LONG');if(lpEx&&parseFloat(lpEx.positionAmt)!==0){currentLongPosition.quantity=Math.abs(parseFloat(lpEx.positionAmt));currentLongPosition.entryPrice=parseFloat(lpEx.entryPrice);}else{currentLongPosition=null;addLog("  Warn: Long pos không còn sau khi thêm.");}}
                if(currentShortPosition){const spEx=updatedPos.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='SHORT');if(spEx&&parseFloat(spEx.positionAmt)!==0){currentShortPosition.quantity=Math.abs(parseFloat(spEx.positionAmt));currentShortPosition.entryPrice=parseFloat(spEx.entryPrice);}else{currentShortPosition=null;addLog("  Warn: Short pos không còn sau khi thêm.");}}
                let tpslOk=true; if(currentLongPosition?.quantity>0){if(!await setTPAndSLForPosition(currentLongPosition,true))tpslOk=false;await sleep(300);} if(currentShortPosition?.quantity>0){if(!await setTPAndSLForPosition(currentShortPosition,true))tpslOk=false;} if(!tpslOk)addLog(`[${currentBotMode.toUpperCase()} ADD] Lỗi đặt lại TP/SL.`); success=true;
            }
        }
    } catch (err) { errOccurred = err; addLog(`[${currentBotMode.toUpperCase()} ADD] Lỗi mở lại lệnh ${positionToModify.side}: ${err.msg || err.message}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); success = false;
    } finally { isProcessingTrade = false; return success; }
}
async function openGridPositionAndSetTPSL(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    if(!symbol) return null; addLog(`[LƯỚI] Mở ${tradeDirection} ${symbol} bước ${stepIndex}, giá ~${entryPriceToTarget.toFixed(4)}`);
    isProcessingTrade = true; let errOccurred = null; let gridPos = null;
    try { const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi details ${symbol}.`); const maxLev = await getLeverageBracketForSymbol(symbol); if (!maxLev || maxLev < MIN_LEVERAGE_TO_TRADE) throw new Error(`Đòn bẩy ${maxLev}x < ${MIN_LEVERAGE_TO_TRADE}x.`); if (!await setLeverage(symbol, maxLev)) throw new Error(`Lỗi đặt đòn bẩy.`); await sleep(200);
        let qty = (INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO * maxLev) / entryPriceToTarget; qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision)); if (qty * entryPriceToTarget < details.minNotional) throw new Error(`Giá trị lệnh lưới ${qty*entryPriceToTarget} USDT quá nhỏ.`);
        const orderSide = (tradeDirection==='LONG')?'BUY':'SELL'; const marketOrderRes = await callSignedAPI('/fapi/v1/order','POST',{symbol,side:orderSide,positionSide:tradeDirection,type:'MARKET',quantity:qty,newOrderRespType:'RESULT',newClientOrderId:`GRID-M-${tradeDirection[0]}${stepIndex}-${Date.now()}`});
        const actualEntry=parseFloat(marketOrderRes.avgPrice); const actualQty=parseFloat(marketOrderRes.executedQty); if(actualQty===0)throw new Error(`Lệnh lưới ${symbol} không khớp KL.`); addLog(`[LƯỚI] Đã MỞ ${tradeDirection} ${symbol} KL:${actualQty.toFixed(details.quantityPrecision)}, Giá:${actualEntry.toFixed(details.pricePrecision)}`);
        gridPos = {id:marketOrderRes.orderId,symbol,side:tradeDirection,entryPrice:actualEntry,quantity:actualQty,tpOrderId:null,slOrderId:null,originalAnchorPrice:sidewaysGrid.anchorPrice,stepIndex,pricePrecision:details.pricePrecision,quantityPrecision:details.quantityPrecision};
        let tpVal=actualEntry*(1+(tradeDirection==='LONG'?SIDEWAYS_TP_PERCENT_FROM_ENTRY:-SIDEWAYS_TP_PERCENT_FROM_ENTRY)); let slVal=actualEntry*(1-(tradeDirection==='LONG'?SIDEWAYS_SL_PERCENT_FROM_ENTRY:-SIDEWAYS_SL_PERCENT_FROM_ENTRY)); tpVal=parseFloat(tpVal.toFixed(details.pricePrecision));slVal=parseFloat(slVal.toFixed(details.pricePrecision)); const tpslSideClose=(tradeDirection==='LONG')?'SELL':'BUY';
        try{const tpOrd=await callSignedAPI('/fapi/v1/order','POST',{symbol,side:tpslSideClose,positionSide:tradeDirection,type:'TAKE_PROFIT_MARKET',stopPrice:tpVal,quantity:actualQty,timeInForce:'GTC',closePosition:'true',newClientOrderId:`GRID-TP-${tradeDirection[0]}${stepIndex}-${gridPos.id}-${Date.now()}`});gridPos.tpOrderId=tpOrd.orderId;addLog(`  [LƯỚI] Đặt TP ${tradeDirection} ${symbol} @${tpVal.toFixed(details.pricePrecision)} (ID:${tpOrd.orderId})`);}catch(e){addLog(`  [LƯỚI] LỖI đặt TP ${tradeDirection} ${symbol}: ${e.msg||e.message}`);}
        try{const slOrd=await callSignedAPI('/fapi/v1/order','POST',{symbol,side:tpslSideClose,positionSide:tradeDirection,type:'STOP_MARKET',stopPrice:slVal,quantity:actualQty,timeInForce:'GTC',closePosition:'true',newClientOrderId:`GRID-SL-${tradeDirection[0]}${stepIndex}-${gridPos.id}-${Date.now()}`});gridPos.slOrderId=slOrd.orderId;addLog(`  [LƯỚI] Đặt SL ${tradeDirection} ${symbol} @${slVal.toFixed(details.pricePrecision)} (ID:${slOrd.orderId})`);}catch(e){addLog(`  [LƯỚI] LỖI đặt SL ${tradeDirection} ${symbol}: ${e.msg||e.message}`);}
        sidewaysGrid.activeGridPositions.push(gridPos);
    } catch (err) { errOccurred = err; addLog(`[LƯỚI] LỖI MỞ LỆNH ${tradeDirection} ${symbol}: ${err.msg || err.message}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); gridPos = null;
    } finally { isProcessingTrade = false; return gridPos; }
}
async function closeSpecificGridPosition(gridPosObj, reasonForClose, isSlEvent = false, isTpEvent = false) {
    if (!gridPosObj || !gridPosObj.symbol) return; isProcessingTrade = true;
    addLog(`[LƯỚI] Đóng lệnh ${gridPosObj.side} ${gridPosObj.symbol} ID ${gridPosObj.id} @${gridPosObj.entryPrice.toFixed(gridPosObj.pricePrecision||4)}. Lý do: ${reasonForClose}`);
    if(gridPosObj.tpOrderId){try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol:gridPosObj.symbol,orderId:gridPosObj.tpOrderId});addLog(`  [LƯỚI] Hủy TP ${gridPosObj.tpOrderId}.`);}catch(e){if(e.code!==-2011)addLog(`  [LƯỚI] Lỗi hủy TP ${gridPosObj.tpOrderId}: ${e.msg||e.message}`);else addLog(`  [LƯỚI] TP ${gridPosObj.tpOrderId} có thể đã khớp/hủy.`);}}
    if(gridPosObj.slOrderId){try{await callSignedAPI('/fapi/v1/order','DELETE',{symbol:gridPosObj.symbol,orderId:gridPosObj.slOrderId});addLog(`  [LƯỚI] Hủy SL ${gridPosObj.slOrderId}.`);}catch(e){if(e.code!==-2011)addLog(`  [LƯỚI] Lỗi hủy SL ${gridPosObj.slOrderId}: ${e.msg||e.message}`);else addLog(`  [LƯỚI] SL ${gridPosObj.slOrderId} có thể đã khớp/hủy.`);}}
    await sleep(300);
    if(!isSlEvent&&!isTpEvent){try{const details=await getSymbolDetails(gridPosObj.symbol);if(details&&gridPosObj.quantity>0){const qtyClose=parseFloat(gridPosObj.quantity.toFixed(details.quantityPrecision));const sideCloseOrder=gridPosObj.side==='LONG'?'SELL':'BUY';const positions=await callSignedAPI('/fapi/v2/positionRisk','GET',{symbol:gridPosObj.symbol});const currentActualPos=positions.find(p=>p.symbol===gridPosObj.symbol&&p.positionSide===gridPosObj.side);const actualQtyOnEx=Math.abs(parseFloat(currentActualPos?.positionAmt||"0"));if(actualQtyOnEx>=qtyClose*0.9){addLog(`  [LƯỚI] Gửi MARKET đóng ${qtyClose} ${gridPosObj.side} ${gridPosObj.symbol}`);await callSignedAPI('/fapi/v1/order','POST',{symbol:gridPosObj.symbol,side:sideCloseOrder,positionSide:gridPosObj.side,type:'MARKET',quantity:qtyClose,newClientOrderId:`GRID-MANCLOSE-${gridPosObj.side[0]}${gridPosObj.stepIndex}-${gridPosObj.id}-${Date.now()}`});}else addLog(`  [LƯỚI] Không đủ KL (${actualQtyOnEx.toFixed(details.quantityPrecision)}) trên sàn để đóng ${qtyClose}.`);}}catch(err){addLog(`  [LƯỚI] Lỗi MARKET đóng ${gridPosObj.side} ID ${gridPosObj.id}: ${err.msg||err.message}`);}}
    sidewaysGrid.activeGridPositions=sidewaysGrid.activeGridPositions.filter(p=>p.id!==gridPosObj.id); addLog(`  [LƯỚI] Đã xóa lệnh lưới ID ${gridPosObj.id}. Còn ${sidewaysGrid.activeGridPositions.length}.`);
    if(isSlEvent)sidewaysGrid.sidewaysStats.slMatchedCount++; if(isTpEvent)sidewaysGrid.sidewaysStats.tpMatchedCount++; isProcessingTrade=false;
}
async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || isProcessingTrade || sidewaysGrid.isClearingForKillSwitch || !TARGET_COIN_SYMBOL) return;
    const details = await getSymbolDetails(TARGET_COIN_SYMBOL); if (!details) { addLog("[LƯỚI] Không có details, không thể quản lý lưới."); return; } const pricePrecision = details.pricePrecision;
    const posFromAnchor = sidewaysGrid.activeGridPositions.filter(p => p.originalAnchorPrice === sidewaysGrid.anchorPrice);
    if (posFromAnchor.length === 0) { let sideToOpen=null,targetEntry=null; if(currentMarketPrice>=sidewaysGrid.anchorPrice*(1+SIDEWAYS_INITIAL_TRIGGER_PERCENT)){sideToOpen='SHORT';targetEntry=sidewaysGrid.anchorPrice*(1+SIDEWAYS_INITIAL_TRIGGER_PERCENT);}else if(currentMarketPrice<=sidewaysGrid.anchorPrice*(1-SIDEWAYS_INITIAL_TRIGGER_PERCENT)){sideToOpen='LONG';targetEntry=sidewaysGrid.anchorPrice*(1-SIDEWAYS_INITIAL_TRIGGER_PERCENT);} if(sideToOpen){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger. Mở ${sideToOpen} quanh ${targetEntry.toFixed(pricePrecision)}.`);await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL,sideToOpen,targetEntry,0);}}
    const MAX_STEPS=Math.floor(SIDEWAYS_GRID_RANGE_PERCENT/SIDEWAYS_GRID_STEP_PERCENT);
    for(let i=1;i<=MAX_STEPS;i++){const shortTrig=sidewaysGrid.anchorPrice*(1+i*SIDEWAYS_GRID_STEP_PERCENT);if(currentMarketPrice>=shortTrig&&!sidewaysGrid.activeGridPositions.find(p=>p.side==='SHORT'&&p.stepIndex===i&&p.originalAnchorPrice===sidewaysGrid.anchorPrice)){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger Short bước ${i}.`);await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL,'SHORT',shortTrig,i);} const longTrig=sidewaysGrid.anchorPrice*(1-i*SIDEWAYS_GRID_STEP_PERCENT);if(currentMarketPrice<=longTrig&&!sidewaysGrid.activeGridPositions.find(p=>p.side==='LONG'&&p.stepIndex===i&&p.originalAnchorPrice===sidewaysGrid.anchorPrice)){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger Long bước ${i}.`);await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL,'LONG',longTrig,i);}}
    if(currentMarketPrice>sidewaysGrid.gridUpperLimit||currentMarketPrice<sidewaysGrid.gridLowerLimit){addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) vượt phạm vi. Dịch chuyển anchor.`);sidewaysGrid.anchorPrice=currentMarketPrice;sidewaysGrid.gridUpperLimit=sidewaysGrid.anchorPrice*(1+SIDEWAYS_GRID_RANGE_PERCENT);sidewaysGrid.gridLowerLimit=sidewaysGrid.anchorPrice*(1-SIDEWAYS_GRID_RANGE_PERCENT);sidewaysGrid.lastGridMoveTime=Date.now();}
    if(Date.now()-(sidewaysGrid.lastVolatilityCheckTime||0)>VOLATILITY_CHECK_INTERVAL_MS){sidewaysGrid.lastVolatilityCheckTime=Date.now();const coinDataV1=getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);const vps1Vol=coinDataV1?Math.abs(coinDataV1.changePercent):null;if(vps1Vol!==null&&vps1Vol>=OVERALL_VOLATILITY_THRESHOLD_VPS1){addLog(`[LƯỚI] ${TARGET_COIN_SYMBOL} sang KILL do Vol VPS1 (${vps1Vol.toFixed(2)}%)>=${OVERALL_VOLATILITY_THRESHOLD_VPS1}%.`);if(!sidewaysGrid.isClearingForKillSwitch){sidewaysGrid.isClearingForKillSwitch=true;await closeAllSidewaysPositionsAndOrders(`Chuyển KILL (Vol VPS1 ${vps1Vol.toFixed(2)}%)`);if(sidewaysGrid.killSwitchDelayTimeout)clearTimeout(sidewaysGrid.killSwitchDelayTimeout);addLog(`  [LƯỚI] Chờ ${KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS/1000}s trước khi kích hoạt KILL.`);sidewaysGrid.killSwitchDelayTimeout=setTimeout(async()=>{addLog(`[LƯỚI] Hết chờ. Kích hoạt KILL.`);currentBotMode='kill';sidewaysGrid.isClearingForKillSwitch=false;sidewaysGrid.isActive=false;if(currentLongPosition)currentLongPosition=null;if(currentShortPosition)currentShortPosition=null;await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);if(botRunning)scheduleNextMainCycle(1000);},KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS);}return;}}}
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

async function checkOverallTPSL() { return false; }

async function runTradingLogic() {
    if (!botRunning || isProcessingTrade || sidewaysGrid.isClearingForKillSwitch) {
        if(isProcessingTrade) addLog("runTradingLogic: Bỏ qua do isProcessingTrade=true");
        if(sidewaysGrid.isClearingForKillSwitch) addLog("runTradingLogic: Bot đang dọn lưới, bỏ qua.");
        return;
    }
    if (await checkOverallTPSL()) return;

    if (!TARGET_COIN_SYMBOL || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive)) {
        addLog(`TARGET_COIN_SYMBOL (${TARGET_COIN_SYMBOL || 'N/A'}) chưa có hoặc không có lệnh/lưới. Chọn coin mới...`);
        const newCoinSymbol = await selectTargetCoin(!TARGET_COIN_SYMBOL);
        if (newCoinSymbol) {
            if (TARGET_COIN_SYMBOL && TARGET_COIN_SYMBOL !== newCoinSymbol) {
                addLog(`TARGET_COIN_SYMBOL đổi từ ${TARGET_COIN_SYMBOL} sang ${newCoinSymbol}. Dọn dẹp coin cũ.`);
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            }
            TARGET_COIN_SYMBOL = newCoinSymbol;
            totalProfit = 0; totalLoss = 0; netPNL = 0;
            currentLongPosition = null; currentShortPosition = null;
            sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
            if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; }
            setupMarketDataStream(TARGET_COIN_SYMBOL);
        } else {
            addLog("Không chọn được coin mục tiêu mới. Thử lại sau 1 phút.");
            if (botRunning) scheduleNextMainCycle(60000); return;
        }
    }

    if (!TARGET_COIN_SYMBOL) { if (botRunning) scheduleNextMainCycle(60000); return; }

    const currentCoinDataVPS1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1Volatility = currentCoinDataVPS1 ? Math.abs(currentCoinDataVPS1.changePercent) : null;
    const prevMode = currentBotMode;

    if (vps1Volatility !== null) {
        if (vps1Volatility <= OVERALL_VOLATILITY_THRESHOLD_VPS1 && currentBotMode === 'kill' && !currentLongPosition && !currentShortPosition) currentBotMode = 'sideways';
        else if (vps1Volatility > OVERALL_VOLATILITY_THRESHOLD_VPS1 && currentBotMode === 'sideways' && !sidewaysGrid.isClearingForKillSwitch) {
            if (!currentLongPosition && !currentShortPosition) {
                currentBotMode = 'kill';
                if (sidewaysGrid.isActive) {
                    addLog(`Vol VPS1 (${TARGET_COIN_SYMBOL}: ${vps1Volatility.toFixed(2)}%) > ${OVERALL_VOLATILITY_THRESHOLD_VPS1}%. Chuyển Sideways -> Kill. Đóng lưới...`);
                    sidewaysGrid.isClearingForKillSwitch = true;
                    await closeAllSidewaysPositionsAndOrders("Chuyển sang Kill do Vol VPS1 tăng");
                    if(sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout);
                    sidewaysGrid.killSwitchDelayTimeout = setTimeout(async () => {
                        addLog(`Hết chờ đóng lưới (Vol VPS1 tăng). Kích hoạt Kill.`);
                        sidewaysGrid.isClearingForKillSwitch = false;
                        if (botRunning) scheduleNextMainCycle(1000);
                    }, KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS);
                    return;
                }
            }
        }
    }

    if (prevMode !== currentBotMode && !sidewaysGrid.isClearingForKillSwitch) {
        addLog(`Chế độ đổi từ ${prevMode.toUpperCase()} sang ${currentBotMode.toUpperCase()} (Vol VPS1 ${TARGET_COIN_SYMBOL}: ${vps1Volatility !== null ? vps1Volatility.toFixed(2) + '%' : 'N/A'})`);
        if (currentBotMode === 'sideways' && (currentLongPosition || currentShortPosition)) { addLog("  Có lệnh Kill, không vào Sideways."); currentBotMode = 'kill';}
    }

    if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) {
        if (currentBotMode === 'kill') {
            addLog(`Bắt đầu chu kỳ KILL mới cho ${TARGET_COIN_SYMBOL} (Vol VPS1: ${vps1Volatility !== null ? vps1Volatility.toFixed(2) + '%' : 'N/A'})...`);
            try {
                const maxLev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
                if (maxLev < MIN_LEVERAGE_TO_TRADE) { TARGET_COIN_SYMBOL = null; if(botRunning) scheduleNextMainCycle(1000); return; }
                const priceNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!priceNewPair) { if (botRunning) scheduleNextMainCycle(); return; }
                currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLev, priceNewPair); if (!currentLongPosition) { if (botRunning) scheduleNextMainCycle(); return; }
                await sleep(800);
                currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLev, priceNewPair);
                if (!currentShortPosition) { if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT cặp Kill', 'LONG'); currentLongPosition = null; if (botRunning) scheduleNextMainCycle(); return; }
                await sleep(1000); await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                let tpslSet = true;
                if (currentLongPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslSet = false; } await sleep(300);
                if (currentShortPosition?.quantity > 0) { if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslSet = false; }
                if (!tpslSet) { addLog("  Lỗi đặt TP/SL cặp Kill. Đóng cả hai."); if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi TP/SL Kill', 'LONG'); if (currentShortPosition) await closePosition(currentShortPosition.symbol, 'Lỗi TP/SL Kill', 'SHORT'); await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return; }
            } catch (err) { addLog(`  Lỗi mở cặp Kill: ${err.msg || err.message}`); if(err instanceof CriticalApiError) await stopBotLogicInternal(); if(botRunning) scheduleNextMainCycle(); }
        } else if (currentBotMode === 'sideways') {
            addLog(`[LƯỚI] Kích hoạt Sideways cho ${TARGET_COIN_SYMBOL} (Vol VPS1: ${vps1Volatility !== null ? vps1Volatility.toFixed(2) + '%' : 'N/A'}).`);
            const priceAnchor = await getCurrentPrice(TARGET_COIN_SYMBOL); if (!priceAnchor) { if(botRunning) scheduleNextMainCycle(); return; }
            const details = await getSymbolDetails(TARGET_COIN_SYMBOL); if(!details) { if(botRunning) scheduleNextMainCycle(); return; }
            sidewaysGrid.isActive = true; sidewaysGrid.anchorPrice = priceAnchor;
            sidewaysGrid.gridUpperLimit = priceAnchor * (1 + SIDEWAYS_GRID_RANGE_PERCENT); sidewaysGrid.gridLowerLimit = priceAnchor * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
            sidewaysGrid.lastGridMoveTime = Date.now(); sidewaysGrid.lastVolatilityCheckTime = Date.now();
            sidewaysGrid.activeGridPositions = []; sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        }
    }

    if(botRunning && !nextScheduledCycleTimeout) scheduleNextMainCycle();
    if (botRunning && !positionCheckInterval && (currentLongPosition || currentShortPosition || sidewaysGrid.isActive )) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        const checkIntervalMs = currentBotMode === 'kill' ? 5000 : (sidewaysGrid.isActive ? 3000 : 7000) ;
        addLog(`Thiết lập interval kiểm tra vị thế (${currentBotMode}) mỗi ${checkIntervalMs/1000}s.`);
        positionCheckInterval = setInterval(async () => {
            if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
                try { await manageOpenPosition(); }
                catch (e) { addLog(`Lỗi interval manageOpenPosition: ${e.msg || e.message}`); if(e instanceof CriticalApiError) await stopBotLogicInternal(); }
            } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
        }, checkIntervalMs);
    } else if ((!botRunning || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive)) && positionCheckInterval) {
        clearInterval(positionCheckInterval); positionCheckInterval = null;
    }
}

const manageOpenPosition = async () => {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForKillSwitch || !TARGET_COIN_SYMBOL) return;
    if (await checkOverallTPSL()) return;

    const currentCoinDataFromVPS1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1VolForCurrentCoin = currentCoinDataFromVPS1 ? Math.abs(currentCoinDataFromVPS1.changePercent) : null;

    if (vps1VolForCurrentCoin !== null) {
        if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
            if (vps1VolForCurrentCoin <= OVERALL_VOLATILITY_THRESHOLD_VPS1) {
                addLog(`[KILL] Vol VPS1 ${TARGET_COIN_SYMBOL} (${vps1VolForCurrentCoin.toFixed(2)}%) <= ${OVERALL_VOLATILITY_THRESHOLD_VPS1}%. Chuyển sang SIDEWAYS.`);
                currentBotMode = 'sideways';
                if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển Sideways (Vol VPS1 giảm)`, "LONG");
                if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển Sideways (Vol VPS1 giảm)`, "SHORT");
                currentLongPosition = null; currentShortPosition = null; await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                sidewaysGrid.isActive = true; // Kích hoạt lưới
                if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
                scheduleNextMainCycle(1000); return;
            }
        } else if (currentBotMode === 'sideways' && vps1VolForCurrentCoin > OVERALL_VOLATILITY_THRESHOLD_VPS1) {
            if (!currentLongPosition && !currentShortPosition) {
                addLog(`[SIDEWAYS] Vol VPS1 ${TARGET_COIN_SYMBOL} (${vps1VolForCurrentCoin.toFixed(2)}%) > ${OVERALL_VOLATILITY_THRESHOLD_VPS1}%. Chuyển sang KILL.`);
                currentBotMode = 'kill';
                if (sidewaysGrid.isActive) {
                    sidewaysGrid.isClearingForKillSwitch = true;
                    await closeAllSidewaysPositionsAndOrders("Chuyển sang Kill do Vol VPS1 tăng");
                    if(sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout);
                    sidewaysGrid.killSwitchDelayTimeout = setTimeout(async () => {
                        addLog(`Hết chờ đóng lưới (Vol VPS1 tăng). Kích hoạt Kill.`);
                        sidewaysGrid.isClearingForKillSwitch = false; if (botRunning) scheduleNextMainCycle(1000);
                    }, KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS); return;
                } else { if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; } scheduleNextMainCycle(1000); return; }
            }
        }
    }

    if (currentBotMode === 'kill') {
        if (!currentLongPosition || !currentShortPosition) { if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return; }
        try {
            const positionsData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            let longPosEx = positionsData.find(p => p.positionSide === 'LONG' && p.symbol === TARGET_COIN_SYMBOL);
            let shortPosEx = positionsData.find(p => p.positionSide === 'SHORT' && p.symbol === TARGET_COIN_SYMBOL);

            if (currentLongPosition) { if (longPosEx && Math.abs(parseFloat(longPosEx.positionAmt)) > 0) { currentLongPosition.unrealizedPnl = parseFloat(longPosEx.unRealizedProfit); currentLongPosition.currentPrice = parseFloat(longPosEx.markPrice); currentLongPosition.quantity = Math.abs(parseFloat(longPosEx.positionAmt)); currentLongPosition.entryPrice = parseFloat(longPosEx.entryPrice); } else { addLog(`[KILL] Long ${TARGET_COIN_SYMBOL} không còn trên sàn.`); currentLongPosition = null; }}
            if (currentShortPosition) { if (shortPosEx && Math.abs(parseFloat(shortPosEx.positionAmt)) > 0) { currentShortPosition.unrealizedPnl = parseFloat(shortPosEx.unRealizedProfit); currentShortPosition.currentPrice = parseFloat(shortPosEx.markPrice); currentShortPosition.quantity = Math.abs(parseFloat(shortPosEx.positionAmt)); currentShortPosition.entryPrice = parseFloat(shortPosEx.entryPrice); } else { addLog(`[KILL] Short ${TARGET_COIN_SYMBOL} không còn trên sàn.`); currentShortPosition = null; }}
            if (!currentLongPosition || !currentShortPosition) { if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL); return; }

            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) { winningPos = currentLongPosition; losingPos = currentShortPosition; }
            else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) { winningPos = currentShortPosition; losingPos = currentLongPosition; }
            else {
                if (currentLongPosition.unrealizedPnl < 0 && currentShortPosition.unrealizedPnl < 0) {
                    let pA = currentLongPosition, pB = currentShortPosition; let potentialLosingPos = null;
                    if (pA.hasClosedAllLossPositionAtLastLevel && pA.quantity === 0 && pB.quantity > 0) potentialLosingPos = pB;
                    else if (pB.hasClosedAllLossPositionAtLastLevel && pB.quantity === 0 && pA.quantity > 0) potentialLosingPos = pA;
                    if (potentialLosingPos && potentialLosingPos.closedLossAmount > 0 && potentialLosingPos.pairEntryPrice > 0 && currentMarketPrice && Math.abs(currentMarketPrice - potentialLosingPos.pairEntryPrice) <= (potentialLosingPos.pairEntryPrice * 0.0005) ) {
                        if (!isProcessingTrade) { addLog(`[KILL REOPEN BOTH LOSS] Lệnh ${potentialLosingPos.side} về gần entry cặp. Mở lại.`); await addPosition(potentialLosingPos, potentialLosingPos.closedLossAmount, `price_near_pair_entry_reopen_both_loss`); }
                    }
                }
                for (const posChk of [currentLongPosition, currentShortPosition]) {
                    if (!posChk) continue; const otherP = posChk === currentLongPosition ? currentShortPosition : currentLongPosition;
                    if (otherP && otherP.quantity === 0 && otherP.hasClosedAllLossPositionAtLastLevel && posChk.quantity > 0 && posChk.initialMargin > 0) {
                        const pnlPctChk = (posChk.unrealizedPnl / posChk.initialMargin) * 100; const pnlBaseChk = posChk.pnlBaseForNextMoc || 0;
                        if (posChk.partialCloseLossLevels && posChk.partialCloseLossLevels.length > PARTIAL_CLOSE_INDEX_5) {
                            const moc5RelPnl = posChk.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5]; const threshMoc5 = pnlBaseChk + moc5RelPnl;
                            if (pnlPctChk >= threshMoc5 && posChk.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_5) {
                                addLog(`[KILL REOPEN MOC5 RETURN] ${posChk.side} (PNL ${pnlPctChk.toFixed(1)}%) quay lại/vượt Mốc 5. Mở lại ${otherP.side}.`);
                                const reopenedLosing = await openMarketPosition(TARGET_COIN_SYMBOL, otherP.side, otherP.maxLeverageUsed, await getCurrentPrice(TARGET_COIN_SYMBOL));
                                if (reopenedLosing) {
                                    if (otherP.side === 'LONG') currentLongPosition = reopenedLosing; else currentShortPosition = reopenedLosing;
                                    posChk.pnlBaseForNextMoc = pnlPctChk; posChk.nextPartialCloseLossIndex = 0; posChk.hasAdjustedSLToSpecificLevel = {}; posChk.hasClosedAllLossPositionAtLastLevel = false;
                                    reopenedLosing.pnlBaseForNextMoc = 0; reopenedLosing.nextPartialCloseLossIndex = 0; reopenedLosing.hasAdjustedSLToSpecificLevel = {}; reopenedLosing.hasClosedAllLossPositionAtLastLevel = false;
                                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL); await sleep(500);
                                    if (currentLongPosition?.quantity > 0) await setTPAndSLForPosition(currentLongPosition, true); await sleep(300);
                                    if (currentShortPosition?.quantity > 0) await setTPAndSLForPosition(currentShortPosition, true); return;
                                }
                            }
                        }
                    }
                } return;
            }

            if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0 && winningPos.initialMargin > 0) {
                const pnlPctWin = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100; const pnlBaseWin = winningPos.pnlBaseForNextMoc || 0;
                if (winningPos.nextPartialCloseLossIndex >= winningPos.partialCloseLossLevels.length) {
                    if (losingPos.quantity > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel) { addLog(`[KILL] Lệnh thắng ${winningPos.side} đã qua hết mốc. Đóng lệnh lỗ ${losingPos.side}.`); await closePosition(losingPos.symbol, `Thắng qua hết mốc, đóng lỗ`, losingPos.side); losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; } return;
                }
                const targetMocRelPnl = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex]; const absThreshMoc = pnlBaseWin + targetMocRelPnl;
                const moc5RelPnlVal = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_5]; const moc8RelPnlVal = winningPos.partialCloseLossLevels[PARTIAL_CLOSE_INDEX_8];
                if (moc5RelPnlVal === undefined || moc8RelPnlVal === undefined) { addLog(`Lỗi: partialCloseLossLevels không đúng.`); return; }

                let actionTakenThisCycle = false;
                if (pnlPctWin >= absThreshMoc) {
                    actionTakenThisCycle = true; const mocIdxReached = winningPos.nextPartialCloseLossIndex;
                    addLog(`[KILL MÓC] ${winningPos.side} ${TARGET_COIN_SYMBOL} đạt Mốc ${mocIdxReached + 1} (PNL ${pnlPctWin.toFixed(1)}% >= ngưỡng ${absThreshMoc.toFixed(1)}%).`);
                    let qtyFractionToClose = (mocIdxReached === PARTIAL_CLOSE_INDEX_5) ? 0.20 : (mocIdxReached >= PARTIAL_CLOSE_INDEX_8) ? 1.00 : 0.10;
                    const qtyToCloseLosing = losingPos.initialQuantity * qtyFractionToClose;
                    if(await closePartialPosition(losingPos, qtyToCloseLosing)) { winningPos.nextPartialCloseLossIndex++; addLog(`  Đã tăng mốc lệnh thắng ${winningPos.side} lên Mốc ${winningPos.nextPartialCloseLossIndex +1}.`); }
                    else { addLog(`  Không thể đóng một phần lệnh lỗ ${losingPos.side}. Mốc lệnh thắng không tăng.`); }

                    if (mocIdxReached === PARTIAL_CLOSE_INDEX_5 && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[moc5RelPnlVal] && losingPos.initialMargin > 0) {
                        const slTargetPnlPercentForLosing = moc8RelPnlVal;
                        const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100;
                        const targetPnlAtSLLosing_USD = -(losingPos.initialMargin * (slTargetPnlPercentForLosing / 100)) + pnlBaseLosingUSD;
                        const priceChangeForSL = targetPnlAtSLLosing_USD / losingPos.initialQuantity;
                        const slPriceForLosing = parseFloat((losingPos.entryPrice + priceChangeForSL).toFixed(losingPos.pricePrecision));
                        addLog(`  Đạt Mốc 5. Kéo SL lệnh lỗ ${losingPos.side} về giá ${slPriceForLosing.toFixed(losingPos.pricePrecision)} (PNL ${slTargetPnlPercentForLosing}% từ PNL base ${losingPos.pnlBaseForNextMoc || 0}%).`);
                        if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); losingPos.currentSLId=null;} catch(e){if(e.code !== -2011)addLog(`  Warn: Lỗi hủy SL cũ lệnh lỗ: ${e.msg}`);} } await sleep(200);
                        try { const newSLOrder = await callSignedAPI('/fapi/v1/order', 'POST', { symbol: losingPos.symbol, side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'), positionSide: losingPos.side, type: 'STOP_MARKET', stopPrice: slPriceForLosing, quantity: losingPos.quantity, timeInForce: 'GTC', closePosition: 'true', newClientOrderId: `KILL-ADJSL-${losingPos.side[0]}${Date.now()}` }); if (newSLOrder.orderId) { losingPos.currentSLId = newSLOrder.orderId; winningPos.hasAdjustedSLToSpecificLevel[moc5RelPnlVal] = true; addLog(`    Đã đặt SL mới ${newSLOrder.orderId} cho lệnh lỗ ${losingPos.side}.`); }}
                        catch (e) { addLog(`    Lỗi đặt SL mới cho lệnh lỗ ${losingPos.side}: ${e.msg || e.message}.`); await setTPAndSLForPosition(losingPos, false); }
                    }
                    if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_8 && actionTakenThisCycle) ) { losingPos.hasClosedAllLossPositionAtLastLevel = true; addLog(`  Lệnh lỗ ${losingPos.side} đã đóng hết hoặc lệnh thắng đã qua Mốc 8.`); }
                }

                if (winningPos.nextPartialCloseLossIndex > PARTIAL_CLOSE_INDEX_5 && Date.now() - (lastCoinSwitchCheckTime || 0) > 15000) {
                    lastCoinSwitchCheckTime = Date.now();
                    addLog(`Lệnh thắng ${winningPos.side} trên Mốc 5. Kiểm tra chuyển coin...`);
                    const allCoinsFromVPS1 = await fetchAndCacheTopCoinsFromVPS1();
                    if (allCoinsFromVPS1 && allCoinsFromVPS1.length > 0) {
                        const potentialNewCoins = allCoinsFromVPS1.filter(c => c.symbol !== TARGET_COIN_SYMBOL);
                        if (potentialNewCoins.length > 0) {
                            potentialNewCoins.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
                            const bestNewCoinCand = potentialNewCoins[0];
                            const maxLevNewCoin = await getLeverageBracketForSymbol(bestNewCoinCand.symbol); await sleep(150);
                            if (maxLevNewCoin >= MIN_LEVERAGE_TO_TRADE) {
                                const currentCoinV1Data = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
                                const currentV1Vol = currentCoinV1Data ? Math.abs(currentCoinV1Data.changePercent) : 0;
                                const newCoinV1Vol = Math.abs(bestNewCoinCand.changePercent);
                                addLog(`  Coin tiềm năng: ${bestNewCoinCand.symbol} (Vol VPS1: ${newCoinV1Vol.toFixed(2)}%, MaxLev: ${maxLevNewCoin}x). Coin hiện tại ${TARGET_COIN_SYMBOL} (Vol VPS1: ${currentV1Vol.toFixed(2)}%).`);
                                if (newCoinV1Vol >= VOLATILITY_SWITCH_THRESHOLD_PERCENT && (newCoinV1Vol > currentV1Vol + MIN_VOLATILITY_DIFFERENCE_TO_SWITCH)) {
                                    addLog(`ĐIỀU KIỆN CHUYỂN COIN ĐẠT: ${bestNewCoinCand.symbol}. Đóng vị thế hiện tại...`);
                                    isProcessingTrade = true;
                                    if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển coin sang ${bestNewCoinCand.symbol}`, 'LONG');
                                    if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển coin sang ${bestNewCoinCand.symbol}`, 'SHORT');
                                    await sleep(1500);
                                    const oldCoin = TARGET_COIN_SYMBOL; TARGET_COIN_SYMBOL = bestNewCoinCand.symbol;
                                    totalProfit = 0; totalLoss = 0; netPNL = 0; currentLongPosition = null; currentShortPosition = null;
                                    sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
                                    if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; } setupMarketDataStream(TARGET_COIN_SYMBOL);
                                    await cleanupAndResetCycle(oldCoin); isProcessingTrade = false; return;
                                } else { addLog(`  Không đủ điều kiện chuyển coin (Vol hoặc chênh lệch).`); }
                            } else { addLog(`  Coin tiềm năng ${bestNewCoinCand.symbol} có maxLev ${maxLevNewCoin}x < ${MIN_LEVERAGE_TO_TRADE}x.`);}
                        } else { addLog("  Không tìm thấy coin tiềm năng nào khác từ VPS1."); }
                    }
                }
                const absPnlThreshMoc8 = (pnlBaseWin || 0) + moc8RelPnlVal;
                if (pnlPctWin >= absPnlThreshMoc8 && !losingPos.hasClosedAllLossPositionAtLastLevel && losingPos.quantity > 0 && !actionTakenThisCycle) {
                     addLog(`[KILL] Lệnh thắng ${winningPos.side} đạt PNL Mốc 8. Đóng nốt lệnh lỗ ${losingPos.side}.`);
                     if(await closePosition(losingPos.symbol, `Đóng nốt ở Mốc 8 lãi (Kill)`, losingPos.side)) { if (losingPos) { losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; }}
                }
            }
            if (losingPos?.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos?.quantity > 0 && losingPos.pairEntryPrice > 0) {
                const pairEntry = losingPos.pairEntryPrice; const tolerance = pairEntry * 0.0005;
                if (currentMarketPrice && Math.abs(currentMarketPrice - pairEntry) <= tolerance) {
                    if (!isProcessingTrade) { addLog(`[KILL REOPEN] Giá ${TARGET_COIN_SYMBOL} về gần entry cặp của lệnh lỗ ${losingPos.side}. Mở lại.`); await addPosition(losingPos, losingPos.closedLossAmount, `price_near_pair_entry_reopen`);}
                }
            }
        } catch (err) { addLog(`Lỗi manageOpenPosition (Kill): ${err.msg || err.message}`); if(err instanceof CriticalApiError) await stopBotLogicInternal(); }
    } else if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        await manageSidewaysGridLogic();
    }
};

async function processTradeResult(orderInfo) {
    if (isProcessingTrade && orderInfo.X !== 'FILLED' && orderInfo.X !== 'CANCELED' && orderInfo.X !== 'REJECTED' && orderInfo.X !== 'EXPIRED') return;
    const wasProcessing = isProcessingTrade; isProcessingTrade = true;
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide, z: filledQtyStr, S: sideOrder, ap: avgPriceStr, ot: orderType, ci: clientOrderId } = orderInfo;
    const filledQty = parseFloat(filledQtyStr); const realizedPnl = parseFloat(realizedPnlStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED' || filledQty === 0) {
        if (TARGET_COIN_SYMBOL && (orderStatus === 'CANCELED' || orderStatus === 'REJECTED' || orderStatus === 'EXPIRED') && symbol === TARGET_COIN_SYMBOL) addLog(`[Trade Update ${TARGET_COIN_SYMBOL}] Lệnh ${clientOrderId || orderId} (${positionSide} ${sideOrder} ${orderType}) bị ${orderStatus}.`);
        if(!wasProcessing) isProcessingTrade = false; return;
    }
    addLog(`[Trade FILLED ${TARGET_COIN_SYMBOL}] ClientID: ${clientOrderId || 'N/A'} (ID: ${orderId}) | ${positionSide} ${sideOrder} ${orderType} | KL: ${filledQty.toFixed(4)} @ ${parseFloat(avgPriceStr).toFixed(4)} | PNL: ${realizedPnl.toFixed(4)}`);
    if (realizedPnl !== 0) { if (realizedPnl > 0) totalProfit += realizedPnl; else totalLoss += Math.abs(realizedPnl); netPNL = totalProfit - totalLoss; addLog(`  PNL Ròng (${TARGET_COIN_SYMBOL}): ${netPNL.toFixed(2)} (L: ${totalProfit.toFixed(2)}, T: ${totalLoss.toFixed(2)})`); }
    if (await checkOverallTPSL()) { if(!wasProcessing) isProcessingTrade = false; return; }

    if (sidewaysGrid.isActive && TARGET_COIN_SYMBOL === symbol) {
        const matchedGridPos = sidewaysGrid.activeGridPositions.find(p => p.tpOrderId === orderId || p.slOrderId === orderId);
        if (matchedGridPos) {
            const isTp = matchedGridPos.tpOrderId === orderId; const isSl = matchedGridPos.slOrderId === orderId;
            if (isTp) { addLog(`  [LƯỚI TP] Lệnh TP lưới ${matchedGridPos.side} ${symbol} (ID gốc: ${matchedGridPos.id}) khớp.`); await closeSpecificGridPosition(matchedGridPos, `TP lưới khớp`, false, true); }
            else if (isSl) { addLog(`  [LƯỚI SL] Lệnh SL lưới ${matchedGridPos.side} ${symbol} (ID gốc: ${matchedGridPos.id}) khớp.`); await closeSpecificGridPosition(matchedGridPos, `SL lưới khớp`, true, false); }
            if(!wasProcessing) isProcessingTrade = false; return;
        }
    }

    const isLongKillTP = currentLongPosition && orderId === currentLongPosition.currentTPId; const isLongKillSL = currentLongPosition && orderId === currentLongPosition.currentSLId;
    const isShortKillTP = currentShortPosition && orderId === currentShortPosition.currentTPId; const isShortKillSL = currentShortPosition && orderId === currentShortPosition.currentSLId;
    let closedKillPosSide = null;
    if (isLongKillTP || isLongKillSL) closedKillPosSide = 'LONG'; else if (isShortKillTP || isShortKillSL) closedKillPosSide = 'SHORT';

    if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === symbol && closedKillPosSide) {
        addLog(`  [KILL ${isLongKillTP || isShortKillTP ? 'TP' : 'SL'}] Lệnh ${closedKillPosSide} ${TARGET_COIN_SYMBOL} đã khớp.`);
        const remainingPos = (closedKillPosSide === 'LONG') ? currentShortPosition : currentLongPosition;
        if (remainingPos?.quantity > 0 && remainingPos.initialMargin > 0) {
            try { const pData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPos.symbol }); const rEx = pData.find(p => p.symbol === remainingPos.symbol && p.positionSide === remainingPos.side); if (rEx) remainingPos.unrealizedPnl = parseFloat(rEx.unRealizedProfit); } catch (e) { addLog(`  Lỗi lấy PNL lệnh còn lại: ${e.message}`);}
            if (realizedPnl >= 0) { addLog(`  Lệnh ${closedKillPosSide} lời. Đóng nốt ${remainingPos.side}.`); await closePosition(remainingPos.symbol, `Lãi KILL (${closedKillPosSide}) chốt, đóng nốt`, remainingPos.side); }
            else { addLog(`  Lệnh ${closedKillPosSide} lỗ. ${remainingPos.side} tiếp tục.`); remainingPos.pnlBaseForNextMoc = (remainingPos.unrealizedPnl / remainingPos.initialMargin) * 100; remainingPos.nextPartialCloseLossIndex = 0; remainingPos.hasAdjustedSLToSpecificLevel = {}; await cancelAllOpenOrdersForSymbol(remainingPos.symbol); await sleep(300); if (!await setTPAndSLForPosition(remainingPos, true)) { addLog(`  Lỗi đặt lại TP/SL cho ${remainingPos.side}. Đóng.`); await closePosition(remainingPos.symbol, "Lỗi đặt lại TP/SL", remainingPos.side);}}
        }
        if (closedKillPosSide === 'LONG') currentLongPosition = null; else if (closedKillPosSide === 'SHORT') currentShortPosition = null;
        if (!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(symbol);
    } else if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === symbol && clientOrderId && (clientOrderId.includes("PARTIAL") || clientOrderId.includes("ADD") || clientOrderId.includes("CLOSE-"))) {
        addLog(`  Lệnh ${clientOrderId} đã khớp.`); await sleep(1000);
        try {
            const positionsAfter = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            if (currentLongPosition) { const lp = positionsAfter.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='LONG'); currentLongPosition.quantity = lp?Math.abs(parseFloat(lp.positionAmt)):0; if(currentLongPosition.quantity===0)currentLongPosition=null; else currentLongPosition.entryPrice=parseFloat(lp.entryPrice);}
            if (currentShortPosition) { const sp = positionsAfter.find(p=>p.symbol===TARGET_COIN_SYMBOL&&p.positionSide==='SHORT'); currentShortPosition.quantity = sp?Math.abs(parseFloat(sp.positionAmt)):0; if(currentShortPosition.quantity===0)currentShortPosition=null; else currentShortPosition.entryPrice=parseFloat(sp.entryPrice);}
            if(!currentLongPosition && !currentShortPosition && botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
        } catch (e) { addLog(`  Lỗi cập nhật KL sau lệnh ${clientOrderId}: ${e.msg || e.message}`); }
    }
    if(!wasProcessing) isProcessingTrade = false;
}

async function cleanupAndResetCycle(symbolToCleanup) {
    if (!symbolToCleanup && TARGET_COIN_SYMBOL) symbolToCleanup = TARGET_COIN_SYMBOL;
    if (!symbolToCleanup) { addLog("Không có symbol để cleanup."); return; }
    addLog(`Chu kỳ cho ${symbolToCleanup} kết thúc. Dọn dẹp...`);
    if (symbolToCleanup === TARGET_COIN_SYMBOL || !TARGET_COIN_SYMBOL) {
        currentLongPosition = null; currentShortPosition = null;
        sidewaysGrid.isActive = false;
        if (sidewaysGrid.isClearingForKillSwitch) { addLog("  Đang dọn lưới, không schedule lại từ cleanup."); return; }
    }
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; addLog("  Đã xóa interval kiểm tra vị thế."); }
    await cancelAllOpenOrdersForSymbol(symbolToCleanup);
    await checkAndHandleRemainingPosition(symbolToCleanup);
    if (botRunning && !sidewaysGrid.isClearingForKillSwitch) {
        addLog(`  Lên lịch cho chu kỳ tiếp theo sau 1 giây (sau cleanup).`);
        scheduleNextMainCycle(1000);
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
        if (!TARGET_COIN_SYMBOL) throw new Error("Không thể chọn coin mục tiêu ban đầu từ VPS1 (đáp ứng đòn bẩy & chưa có vị thế).");
        addLog(`Coin mục tiêu ban đầu: ${TARGET_COIN_SYMBOL}`);

        totalProfit = 0; totalLoss = 0; netPNL = 0; currentLongPosition = null; currentShortPosition = null;
        isProcessingTrade = false; consecutiveApiErrors = 0;
        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);
        listenKey = await getListenKey();
        if (listenKey) setupUserDataStream(listenKey); else addLog("Không lấy được listenKey.");
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        botRunning = true; botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        scheduleNextMainCycle(1000); return 'Bot khởi động thành công.';
    } catch (err) {
        const errorMsg = err.msg || err.message || 'Lỗi không xác định khi khởi động'; addLog(`Lỗi nghiêm trọng khi khởi động: ${errorMsg}`);
        botRunning = false;
        if (!(err instanceof CriticalApiError && (errorMsg.includes("API_KEY") || errorMsg.includes("SECRET_KEY"))) && !retryBotTimeout) {
            addLog(`Thử khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => { retryBotTimeout = null; await startBotLogicInternal(); }, ERROR_RETRY_DELAY_MS);
        } return `Lỗi khởi động: ${errorMsg}.`;
    }
}
async function stopBotLogicInternal() {
    if (!botRunning && !retryBotTimeout) return 'Bot không chạy hoặc không đang retry.';
    addLog('--- Dừng Bot ---'); botRunning = false;
    if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout); nextScheduledCycleTimeout = null;
    if (positionCheckInterval) clearInterval(positionCheckInterval); positionCheckInterval = null;
    if (sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout); sidewaysGrid.killSwitchDelayTimeout = null;
    sidewaysGrid.isClearingForKillSwitch = false;
    if (sidewaysGrid.isActive) await closeAllSidewaysPositionsAndOrders("Bot dừng").catch(e => addLog(`Lỗi đóng lệnh lưới: ${e.message}`));
    sidewaysGrid.isActive = false; sidewaysGrid.activeGridPositions = [];
    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null;
    if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; addLog("Market Stream đã đóng."); }
    if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.terminate(); userDataWs = null; addLog("User Stream đã đóng."); }
    if (listenKey) await callSignedAPI('/fapi/v1/listenKey', 'DELETE', { listenKey }).then(()=>addLog("ListenKey đã xóa.")).catch(e=>addLog(`Lỗi xóa listenKey: ${e.msg||e.message}`));
    listenKey = null;
    if (currentLongPosition && TARGET_COIN_SYMBOL) await closePosition(TARGET_COIN_SYMBOL, "Bot dừng", "LONG").catch(e => addLog(`Lỗi đóng Long: ${e.message}`));
    if (currentShortPosition && TARGET_COIN_SYMBOL) await closePosition(TARGET_COIN_SYMBOL, "Bot dừng", "SHORT").catch(e => addLog(`Lỗi đóng Short: ${e.message}`));
    if (TARGET_COIN_SYMBOL) await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
    currentLongPosition = null; currentShortPosition = null; isProcessingTrade = false;
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
    } catch (error) { addLog(`Lỗi dọn vị thế sót cho ${symbol}: ${error.msg || error.message}`); if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal(); }
}
function scheduleNextMainCycle(delayMs = 7000) {
    if (!botRunning) return; if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = setTimeout(async () => {
        if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
            try { await runTradingLogic(); }
            catch (e) { addLog(`Lỗi chu kỳ chính runTradingLogic (${TARGET_COIN_SYMBOL||'N/A'}): ${e.msg||e.message} ${e.stack?.substring(0,300)||''}`); if (e instanceof CriticalApiError) await stopBotLogicInternal(); else if (botRunning) scheduleNextMainCycle(15000); }
        } else if (botRunning) { scheduleNextMainCycle(delayMs); }
    }, delayMs);
}
async function getListenKey() { if (!API_KEY || !SECRET_KEY) {addLog("Thiếu API key/secret."); return null;} try { const r = await callSignedAPI('/fapi/v1/listenKey', 'POST'); addLog("Lấy ListenKey thành công."); return r.listenKey; } catch (e) { addLog(`Lỗi lấy listenKey: ${e.msg || e.message}`); return null; } }
async function keepAliveListenKey(key) { if (!key) return; try { await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: key }); addLog("Gia hạn ListenKey."); } catch (e) { addLog(`Lỗi gia hạn listenKey (${key}): ${e.msg || e.message}.`); if (botRunning && userDataWs) { userDataWs.terminate(); userDataWs = null; listenKey = null; addLog("User Stream đóng do lỗi gia hạn key. Thử kết nối lại.");} } }

function setupUserDataStream(key) {
    if (!key) { addLog("Không có listenKey cho User Stream."); return; }
    if (userDataWs && (userDataWs.readyState === WebSocket.OPEN || userDataWs.readyState === WebSocket.CONNECTING)) { userDataWs.removeAllListeners(); userDataWs.terminate(); userDataWs = null; }
    const url = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`; userDataWs = new WebSocket(url); addLog("Đang kết nối User Data Stream...");
    userDataWs.on('open', () => { addLog('User Data Stream đã kết nối.'); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = setInterval(() => keepAliveListenKey(listenKey), 30 * 60 * 1000); });
    userDataWs.on('message', async (data) => { try { const msg = JSON.parse(data.toString()); if (msg.e === 'ORDER_TRADE_UPDATE') await processTradeResult(msg.o); else if (msg.e === 'listenKeyExpired') { addLog("User Stream: ListenKey hết hạn."); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); const newKey = await getListenKey(); if (newKey) {listenKey = newKey; setupUserDataStream(newKey);} else addLog("Không lấy được key mới sau khi hết hạn.");}} catch (e) { addLog('Lỗi xử lý User Data Stream: ' + e.message + `. Data: ${data.toString().substring(0,100)}`); } });
    userDataWs.on('error', (err) => addLog('Lỗi User Data Stream: ' + err.message));
    userDataWs.on('close', async (code, reason) => { addLog(`User Data Stream đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}.`); if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; if (botRunning) { addLog("  Thử kết nối lại User Stream sau 5s..."); await sleep(5000); const newKey = await getListenKey(); if (newKey) {listenKey = newKey; setupUserDataStream(newKey);} else addLog("  Không lấy được listenKey mới."); } });
}
function setupMarketDataStream(symbol) {
    if (!symbol) { addLog("Không có symbol cho Market Stream."); return; }
    if (marketWs && (marketWs.readyState === WebSocket.OPEN || marketWs.readyState === WebSocket.CONNECTING)) { const oldS = marketWs.url.split('/').pop().split('@')[0].toUpperCase(); if (oldS.toLowerCase() === symbol.toLowerCase()) { addLog(`Market stream ${symbol} đã chạy.`); return; } addLog(`Đóng Market Stream cũ ${oldS}...`); marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; }
    const streamName = `${symbol.toLowerCase()}@markPrice@1s`; const url = `${WS_BASE_URL}/ws/${streamName}`;
    marketWs = new WebSocket(url); addLog(`Đang kết nối Market Data Stream cho ${symbol} (${url})...`);
    marketWs.on('open', () => addLog(`Market Data Stream ${symbol} đã kết nối.`));
    marketWs.on('message', (data) => { try { const msg = JSON.parse(data.toString()); if (msg.e === 'markPriceUpdate' && msg.s === TARGET_COIN_SYMBOL) { currentMarketPrice = parseFloat(msg.p); if(currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice; if(currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice; } } catch (e) { addLog(`Lỗi xử lý Market Stream (${symbol}): ` + e.message + `. Data: ${data.toString().substring(0,100)}`); } });
    marketWs.on('error', (err) => addLog(`Lỗi Market Data Stream (${symbol}): ` + err.message));
    marketWs.on('close', (code, reason) => { const closedS = marketWs && marketWs.url ? marketWs.url.split('/').pop().split('@')[0].toUpperCase() : symbol; addLog(`Market Stream (${closedS}) đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}.`); if (botRunning && closedS === TARGET_COIN_SYMBOL) { addLog(`Thử kết nối lại Market Stream ${TARGET_COIN_SYMBOL} sau 5s...`); setTimeout(() => setupMarketDataStream(TARGET_COIN_SYMBOL), 5000); } else if (botRunning && closedS !== TARGET_COIN_SYMBOL) addLog(`Market stream coin cũ ${closedS} đóng.`); });
}

const app = express(); app.use(express.json());
app.get('/', (req, res) => { const indexPath = path.join(__dirname, 'index.html'); if (fs.existsSync(indexPath)) res.sendFile(indexPath); else res.status(404).send("<h1>Bot Control Panel</h1><p>File index.html không tìm thấy trong thư mục gốc của bot.</p>"); });
app.get('/api/logs', (req, res) => { fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => { if (err) {addLog(`Lỗi đọc log: ${err.message}`); return res.status(500).send('Lỗi đọc log.');} const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''); res.type('text/plain').send(cleanData.split('\n').slice(-500).join('\n')); }); });
app.get('/api/status', async (req, res) => {
    let pm2Status = "PM2 không lấy được."; try { const pm2List = await new Promise((resolve, reject) => exec('pm2 jlist', {timeout:3000}, (e,o,s)=>e?reject(s||e.message):resolve(o))); const procs = JSON.parse(pm2List); const botP = procs.find(p=>p.name===THIS_BOT_PM2_NAME||(p.pm2_env?.PORT&&parseInt(p.pm2_env.PORT)===WEB_SERVER_PORT)); if(botP)pm2Status=`PM2 ${botP.name}: ${botP.pm2_env.status.toUpperCase()} (R:${botP.pm2_env.restart_time},U:${Math.floor(botP.pm2_env.pm_uptime/(1000*60))}p)`; else pm2Status=`PM2 '${THIS_BOT_PM2_NAME}'(Port ${WEB_SERVER_PORT}) not found.`;}catch(err){pm2Status=`Lỗi PM2: ${err.message.substring(0,100)}.`}
    const currentCoinV1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
    const vps1VolDisplay = currentCoinV1 ? Math.abs(currentCoinV1.changePercent).toFixed(2) + '%' : 'N/A';
    let statusMsg = `${pm2Status} | BOT: ${botRunning?'CHẠY':'DỪNG'}`; if(botStartTime&&botRunning)statusMsg+=` | Up Bot: ${Math.floor((Date.now()-botStartTime.getTime())/60000)}p`; statusMsg+=` | Coin: ${TARGET_COIN_SYMBOL||"N/A"} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | Mode: ${currentBotMode.toUpperCase()} (VPS1_Vol:${vps1VolDisplay})`; if(sidewaysGrid.isClearingForKillSwitch)statusMsg+=" (DỌN LƯỚI)";
    let posText = ""; if (currentBotMode==='kill'&&(currentLongPosition||currentShortPosition)){posText=" | Kill: "; if(currentLongPosition){const pnlL=currentLongPosition.unrealizedPnl||0;posText+=`L(KL:${currentLongPosition.quantity.toFixed(currentLongPosition.quantityPrecision||2)} PNL:${pnlL.toFixed(1)} PNLb:${(currentLongPosition.pnlBaseForNextMoc||0).toFixed(0)}% M${(currentLongPosition.nextPartialCloseLossIndex||0)+1}) `;} if(currentShortPosition){const pnlS=currentShortPosition.unrealizedPnl||0;posText+=`S(KL:${currentShortPosition.quantity.toFixed(currentShortPosition.quantityPrecision||2)} PNL:${pnlS.toFixed(1)} PNLb:${(currentShortPosition.pnlBaseForNextMoc||0).toFixed(0)}% M${(currentShortPosition.nextPartialCloseLossIndex||0)+1})`;}} else if(currentBotMode==='sideways'&&sidewaysGrid.isActive){const det=TARGET_COIN_SYMBOL?await getSymbolDetails(TARGET_COIN_SYMBOL):null;const pp=det?det.pricePrecision:4;posText=` | Lưới: ${sidewaysGrid.activeGridPositions.length} lệnh. Anchor: ${sidewaysGrid.anchorPrice?.toFixed(pp)}. SLs: ${sidewaysGrid.sidewaysStats.slMatchedCount}, TPs: ${sidewaysGrid.sidewaysStats.tpMatchedCount}`;} else posText=" | Vị thế: --";
    statusMsg+=posText; statusMsg+=` | PNL Ròng (${TARGET_COIN_SYMBOL||'N/A'}): ${netPNL.toFixed(2)} (L:${totalProfit.toFixed(2)}, T:${totalLoss.toFixed(2)})`;
    res.type('text/plain').send(statusMsg);
});
app.get('/api/bot_stats', async (req, res) => {
    let killPosD = []; if(currentBotMode==='kill'){for(const p of [currentLongPosition,currentShortPosition]){if(p){const d=await getSymbolDetails(p.symbol);const pp=d?d.pricePrecision:2;const qp=d?d.quantityPrecision:3;const pnl=p.unrealizedPnl||0;killPosD.push({type:'kill',side:p.side,entry:p.entryPrice?.toFixed(pp),qty:p.quantity?.toFixed(qp),pnl:pnl.toFixed(2),curPrice:p.currentPrice?.toFixed(pp),initQty:p.initialQuantity?.toFixed(qp),closedLossQty:p.closedLossAmount?.toFixed(qp),pairEntry:p.pairEntryPrice?.toFixed(pp),mocIdx:(p.nextPartialCloseLossIndex||0)+1,pnlBasePercent:(p.pnlBaseForNextMoc||0).toFixed(2),tpId:p.currentTPId,slId:p.currentSLId});}}}
    let gridPosD = []; if(sidewaysGrid.isActive&&sidewaysGrid.activeGridPositions.length>0){for(const p of sidewaysGrid.activeGridPositions){const d=await getSymbolDetails(p.symbol);const ppG=d?d.pricePrecision:4;const qpG=d?d.quantityPrecision:4;let pnlU=0;if(currentMarketPrice&&p.entryPrice&&p.quantity)pnlU=(currentMarketPrice-p.entryPrice)*p.quantity*(p.side==='LONG'?1:-1);gridPosD.push({type:'grid',id:p.id,side:p.side,entry:p.entryPrice?.toFixed(ppG),qty:p.quantity?.toFixed(qpG),curPrice:currentMarketPrice?.toFixed(ppG),pnl:pnlU.toFixed(2),originalAnchor:p.originalAnchorPrice?.toFixed(ppG),step:p.stepIndex,tpId:p.tpOrderId,slId:p.slOrderId});}}
    const cDet=TARGET_COIN_SYMBOL?await getSymbolDetails(TARGET_COIN_SYMBOL):null;const cPP=cDet?cDet.pricePrecision:4;
    const currentCoinV1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL); const vps1VolDisp = currentCoinV1 ? Math.abs(currentCoinV1.changePercent).toFixed(2) + '%' : 'N/A';
    res.json({success:true,data:{botRunning,currentMode:currentBotMode.toUpperCase(),vps1Volatility:vps1VolDisp,totalProfit:totalProfit.toFixed(2),totalLoss:totalLoss.toFixed(2),netPNL:netPNL.toFixed(2),currentCoin:TARGET_COIN_SYMBOL||"N/A",initialInvestment:INITIAL_INVESTMENT_AMOUNT,killPositions:killPosD,sidewaysGridInfo:{isActive:sidewaysGrid.isActive,isClearingForKillSwitch:sidewaysGrid.isClearingForKillSwitch,anchorPrice:sidewaysGrid.anchorPrice?.toFixed(cPP),upperLimit:sidewaysGrid.gridUpperLimit?.toFixed(cPP),lowerLimit:sidewaysGrid.gridLowerLimit?.toFixed(cPP),stats:{tpCount:sidewaysGrid.sidewaysStats.tpMatchedCount,slCount:sidewaysGrid.sidewaysStats.slMatchedCount},activePositions:gridPosD},vps1DataUrl:VPS1_DATA_URL,botStartTime:botStartTime?formatTimeUTC7(botStartTime):"N/A",currentMarketPrice:currentMarketPrice?.toFixed(cPP)}});
});
app.post('/api/configure', (req, res) => {
    const { initialAmount } = req.body; let changesMade = []; let errors = [];
    if (initialAmount !== undefined) { const newIA = parseFloat(initialAmount); if (!isNaN(newIA) && newIA > 0) { if (newIA !== INITIAL_INVESTMENT_AMOUNT) { INITIAL_INVESTMENT_AMOUNT = newIA; changesMade.push(`Vốn Kill đổi thành ${INITIAL_INVESTMENT_AMOUNT}.`);}} else errors.push("Vốn không hợp lệ.");}
    let msg; if (errors.length > 0) { msg = "Lỗi cấu hình: " + errors.join(" "); if (changesMade.length > 0) msg += " Thay đổi hợp lệ đã áp dụng: " + changesMade.join(" "); addLog(`Cấu hình API thất bại: ${msg}`); res.status(400).json({ success: false, message: msg }); } else if (changesMade.length > 0) { msg = "Cấu hình cập nhật: " + changesMade.join(" "); addLog(msg); res.json({ success: true, message: msg }); } else { msg = "Không có thay đổi cấu hình."; res.json({ success: true, message: msg }); }
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', async (req, res) => res.send(await stopBotLogicInternal()));

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

process.on('unhandledRejection', (reason, promise) => { addLog(`Unhandled Rejection at: ${promise}, reason: ${reason?.stack || reason}`);});
process.on('uncaughtException', (error) => { addLog(`Uncaught Exception: ${error.stack || error}`); if (botRunning) stopBotLogicInternal().finally(() => process.exit(1)); else process.exit(1); });
