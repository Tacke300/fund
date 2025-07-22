
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

const VPS1_DATA_URL = 'http://34.142.248.96:8888/';
const MIN_CANDLES_FOR_SELECTION = 1;
const OVERALL_VOLATILITY_THRESHOLD_VPS1 = 6;
const MIN_VOLATILITY_DIFFERENCE_TO_SWITCH = 4.0;
const MIN_LEVERAGE_TO_TRADE = 50;
const SIDEWAYS_ORDER_SIZE_RATIO = 0.10;
const SIDEWAYS_GRID_STEP_PERCENT = 0.01;
const SIDEWAYS_TP_PRICE_PERCENT = 0.02;
const SIDEWAYS_SL_PRICE_PERCENT = 0.06;
const SIDEWAYS_CHECK_INTERVAL_MS = 1 * 60 * 1000;
const SIDEWAYS_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';
const WEB_SERVER_PORT = 6002;
const THIS_BOT_PM2_NAME = 'GiaCatLuongg';
const CUSTOM_LOG_FILE = path.join(__dirname, `pm2_${THIS_BOT_PM2_NAME}.log`);
const LOG_TO_CUSTOM_FILE = true;
const MAX_CONSECUTIVE_API_ERRORS = 5;
const ERROR_RETRY_DELAY_MS = 10000;
const LOG_COOLDOWN_MS = 2000;
const MODE_SWITCH_DELAY_MS = 5000;
const COIN_SWITCH_DELAY_MS = 5000;
const KILL_MODE_SWITCH_CHECK_INTERVAL_MS = 1 * 60 * 1000;
const STATUS_UPDATE_INTERVAL_MS = 10000;

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
let INITIAL_INVESTMENT_AMOUNT = 1.5;
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
let sidewaysGrid = { isActive: false, anchorPrice: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastCheckTime: 0, isClearingForSwitch: false, switchDelayTimeout: null, sidewaysEntryTimestamp: null, hasOpenedGridPositionThisSession: false };
let isOpeningInitialPair = false;
let overallTakeProfit = 0;
let overallStopLoss = 0;
const pendingClosures = new Set();
let blacklistedCoinsThisSession = new Set();
let isAdjustmentInProgress = false;
let lastKillModeCheckTime = 0;

let statusCache = {
    pm2Status: "Chưa cập nhật",
    fullStatusString: "Bot đang khởi tạo...",
    botStats: { success: false, data: { botRunning: false } }
};
let statusUpdateInterval = null;

class CriticalApiError extends Error { constructor(message) { super(message); this.name = 'CriticalApiError' } }

function addLog(message) {
    const now = new Date();
    const offset = 7 * 60 * 60 * 1000;
    const localTime = new Date(now.getTime() + offset);
    const time = localTime.toLocaleTimeString('en-GB');
    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        if ((localTime.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return;
        }

        if (logCounts[messageHash].count > 1) {
            const repeatCount = logCounts[messageHash].count - 1;
            if (repeatCount > 0) {
                const repeatedMessage = `[${time}] (Lặp lại x${repeatCount} lần) ${message}`;
                console.log(repeatedMessage);
                if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, repeatedMessage + '\n', (err) => { if (err) console.error("Lỗi ghi log:", err) });
            }
        } else {
            let logEntry = `[${time}] ${message}`;
            console.log(logEntry);
            if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => { if (err) console.error("Lỗi ghi log:", err) });
        }
        logCounts[messageHash].count = 0;
        logCounts[messageHash].lastLoggedTime = localTime;
    } else {
        let logEntry = `[${time}] ${message}`;
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => { if (err) console.error("Lỗi ghi log:", err) });
        logCounts[messageHash] = { count: 1, lastLoggedTime: localTime };
    }
}
function formatTimeUTC7(dateObject) {
    if (!dateObject) return 'N/A';
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function createSignature(queryString, apiSecret) { return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex'); }
async function makeHttpRequest(method, urlString, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlString);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: { ...headers, 'User-Agent': 'NodeJS-Client/1.0-VPS2-Bot-Fuller-v3' },
            timeout: 20000
        };
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Lỗi: ${res.statusCode} ${res.statusMessage} khi gọi ${urlString}`;
                    let errorDetails = {
                        code: res.statusCode,
                        msg: errorMsg,
                        url: urlString,
                        responseBody: data.substring(0, 500)
                    };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) { }
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: `${e.message} (khi gọi ${urlString})`, url: urlString }));
        req.on('timeout', () => {
            req.destroy();
            reject({ code: 'TIMEOUT_ERROR', msg: `Request timed out sau ${options.timeout / 1000}s (khi gọi ${urlString})`, url: urlString });
        });
        if (postData && (method === 'POST' || method === 'PUT')) req.write(postData);
        req.end();
    });
}
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Lỗi: Thiếu API_KEY/SECRET_KEY.");
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
        throw new Error(`Phương thức API không hỗ trợ: ${method}`);
    }
    const fullUrlToCall = `https://${BASE_HOST}${requestPath}`;
    try {
        const rawData = await makeHttpRequest(method, fullUrlToCall, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance (${method} ${fullUrlToCall}): ${error.code || 'UNK'} - ${error.msg || error.message}. Body: ${error.responseBody || 'N/A'}`);
        if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) addLog("  -> RATE LIMIT.");
        if (error.code === -1021 && error.msg && error.msg.toLowerCase().includes("timestamp")) await syncServerTime();
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Quá nhiều lỗi API Binance.");
        throw error;
    }
}
async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullPathWithQuery = `${fullEndpointPath}${queryString ? '?' + queryString : ''}`;
    const fullUrlToCall = `https://${BASE_HOST}${fullPathWithQuery}`;
    try {
        const rawData = await makeHttpRequest('GET', fullUrlToCall, {});
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Public Binance (${fullUrlToCall}): ${error.code || 'UNK'} - ${error.msg || error.message}. Body: ${error.responseBody || 'N/A'}`);
        if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) addLog("  -> RATE LIMIT.");
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) throw new CriticalApiError("Quá nhiều lỗi API Public Binance.");
        throw error;
    }
}
const BOT_ID = THIS_BOT_PM2_NAME || `bot-${Date.now().toString().slice(-6)}`;
async function fetchAndCacheTopCoinsFromVPS1(silent = false) {
    const url = new URL(VPS1_DATA_URL);
    url.searchParams.append('bot_id', BOT_ID);
    const fullUrl = url.toString();

    if (!silent) addLog(`Lấy dữ liệu VPS1 & cache: ${fullUrl}`);
    let rawDataForDebug = '';
    try {
        const rawData = await makeHttpRequest('GET', fullUrl);
        rawDataForDebug = rawData;
        const response = JSON.parse(rawData);
        if (response && response.status && Array.isArray(response.data)) {
            if (response.status === "running_data_available") {
                const filtered = response.data.filter(c => c.symbol && typeof c.changePercent === 'number' && c.candles >= MIN_CANDLES_FOR_SELECTION);
                vps1DataCache = [...filtered];
                if (!silent) addLog(`VPS1 data cached: ${filtered.length} coins (status: ${response.status}).`);
                return [...filtered];
            } else if (response.status === "error_binance_symbols" || response.status.startsWith("error")) {
                if (!silent) addLog(`VPS1 error (status: ${response.status}): ${response.message || 'Lỗi VPS1'}. Dùng cache (${vps1DataCache.length}).`);
                return vps1DataCache.length > 0 ? [...vps1DataCache] : [];
            } else {
                if (!silent) addLog(`VPS1 preparing (status: ${response.status}): ${response.message || 'Chưa có message'}. Dùng cache (${vps1DataCache.length}).`);
                return vps1DataCache.length > 0 ? [...vps1DataCache] : [];
            }
        } else {
            if (!silent) addLog(`Lỗi định dạng VPS1. Status: ${response?.status}. Dùng cache (${vps1DataCache.length}). Raw: ${rawData.substring(0, 200)}`);
            return vps1DataCache.length > 0 ? [...vps1DataCache] : [];
        }
    } catch (error) {
        let errMsg = `Lỗi lấy/phân tích VPS1 (${fullUrl}): ${error.code || 'ERR'} - ${error.msg || error.message}.`;
        if (error.responseBody) errMsg += ` Body: ${error.responseBody.substring(0, 100)}`;
        else if (error instanceof SyntaxError && error.message.includes("JSON")) errMsg += ` Lỗi parse JSON. Raw: ${rawDataForDebug.substring(0, 100)}`;
        if (!silent) addLog(errMsg + `. Dùng cache cũ (${vps1DataCache.length} coins).`);
        return vps1DataCache.length > 0 ? [...vps1DataCache] : [];
    }
}
function getCurrentCoinVPS1Data(symbol) {
    if (!symbol || !vps1DataCache || vps1DataCache.length === 0) return null;
    return vps1DataCache.find(c => c.symbol === symbol);
}
async function claimCoinOnServer(coinSymbol) {
    if (!coinSymbol) return false;
    addLog(`[SERVER-COMMS] Báo cáo chiếm coin ${coinSymbol} lên server...`);
    try {
        const url = new URL('/claim_coin', VPS1_DATA_URL).toString();
        const postData = JSON.stringify({ coin: coinSymbol, bot_id: BOT_ID });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };

        await makeHttpRequest('POST', url, headers, postData);
        addLog(`[SERVER-COMMS] Đã chiếm coin ${coinSymbol} trên server thành công.`);
        return true;
    } catch (error) {
        const errorMsg = error.msg || error.message || "Lỗi không xác định";
        addLog(`[SERVER-COMMS] LỖI khi chiếm coin trên server: ${errorMsg}`);
        return false;
    }
}
async function releaseCoinOnServer(coinSymbol) {
    if (!coinSymbol) return true;
    addLog(`[SERVER-COMMS] Báo cáo giải phóng coin ${coinSymbol} lên server...`);
    try {
        const url = new URL('/release_coin', VPS1_DATA_URL).toString();
        const postData = JSON.stringify({ coin: coinSymbol, bot_id: BOT_ID });
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };

        await makeHttpRequest('POST', url, headers, postData);
        addLog(`[SERVER-COMMS] Đã giải phóng coin ${coinSymbol} trên server.`);
        return true;
    } catch (error) {
        const errorMsg = error.msg || error.message || "Lỗi không xác định";
        addLog(`[SERVER-COMMS] LỖI khi giải phóng coin trên server: ${errorMsg}`);
        return false;
    }
}
async function updateStatusOnServer() {
    if (!botRunning || !TARGET_COIN_SYMBOL) return;
    try {
        const url = new URL('/update_status', VPS1_DATA_URL).toString();
        const botData = statusCache.botStats?.data || {};
        const payload = {
            bot_id: BOT_ID,
            net_pnl: parseFloat(botData.netPNL || 0),
            cumulative_pnl: parseFloat(botData.trueOverallPnlSinceStart || 0),
            bot_mode: botData.currentMode || "N/A"
        };
        const postData = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };
        await makeHttpRequest('POST', url, headers, postData);
    } catch (error) {
        const errorMsg = error.msg || error.message || "Lỗi không xác định";
        addLog(`[SERVER-COMMS] LỖI cập nhật trạng thái: ${errorMsg}`);
    }
}
async function getLeverageBracketForSymbol(symbol) {
    if (!symbol) return 20;
    try {
        const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        const b = r.find(i => i.symbol === symbol)?.brackets[0];
        return b ? parseInt(b.initialLeverage) : null;
    } catch (e) {
        addLog(`Lỗi lấy lev bracket ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi lấy lev bracket ${symbol}`);
        return null;
    }
}
async function checkExistingPosition(symbol) {
    if (!symbol) return false;
    try {
        const pos = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        return pos.some(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
    } catch (e) {
        if (e.code === -4003 && e.msg?.toLowerCase().includes("invalid symbol")) return false;
        addLog(`Lỗi check vị thế ${symbol}: ${e.msg || e.message}. Coi như có.`);
        return true;
    }
}
async function selectTargetCoin(isInitialSelection = false) {
    addLog("Bắt đầu quy trình chọn coin mới...");
    const vps1Coins = await fetchAndCacheTopCoinsFromVPS1(true);
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

        for (const coin of vps1Coins) {
            if (!existingPositionsSet.has(coin.symbol) && !blacklistedCoinsThisSession.has(coin.symbol)) {
                addLog(`ĐÃ CHỌN: ${coin.symbol} (Vol: ${coin.changePercent.toFixed(2)}%) vì biến động cao & chưa có vị thế.`);
                return {
                    symbol: coin.symbol,
                    volatility: Math.abs(coin.changePercent)
                };
            }
        }

        addLog("Tất cả coin biến động cao từ VPS1 đều đã có vị thế/blacklist.");
        return null;

    } catch (error) {
        addLog(`Lỗi khi lấy danh sách vị thế để chọn coin: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal("Lỗi API khi lấy vị thế");
        return null;
    }
}
async function syncServerTime() {
    try {
        const d = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = d.serverTime - Date.now();
        addLog(`Đồng bộ thời gian server: Offset ${serverTimeOffset}ms`);
    } catch (e) {
        addLog(`Lỗi đồng bộ thời gian: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) {
            if (botRunning) await stopBotLogicInternal("Lỗi đồng bộ thời gian");
            throw e;
        }
    }
}
async function setLeverage(symbol, leverage) {
    if (!symbol) return false;
    try {
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        return true;
    } catch (e) {
        addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đặt đòn bẩy ${symbol}`);
        return false;
    }
}
async function getExchangeInfo() {
    if (exchangeInfoCache) return exchangeInfoCache;
    try {
        const d = await callPublicAPI('/fapi/v1/exchangeInfo');
        exchangeInfoCache = {};
        d.symbols.forEach(s => {
            const pF = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lF = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const mF = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            exchangeInfoCache[s.symbol] = {
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(pF?.tickSize || 1e-8),
                stepSize: parseFloat(lF?.stepSize || 1e-8),
                minNotional: parseFloat(mF?.notional || 0.1)
            };
        });
        addLog("Lấy Exchange Info.");
        return exchangeInfoCache;
    } catch (e) {
        addLog(`Lỗi lấy Exchange Info: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) {
            if (botRunning) await stopBotLogicInternal("Lỗi lấy Exchange Info");
            throw e;
        }
        throw e;
    }
}
async function getSymbolDetails(symbol) {
    if (!symbol) return null;
    const info = await getExchangeInfo();
    if (!info) return null;
    const details = info[symbol];
    if (!details) {
        addLog(`Không tìm thấy chi tiết ${symbol}. Thử làm mới.`);
        exchangeInfoCache = null;
        const fresh = await getExchangeInfo();
        return fresh?.[symbol] || null;
    }
    return details;
}
async function getCurrentPrice(symbol) {
    if (!symbol) return null;
    try {
        const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(d.price);
    } catch (e) {
        addLog(`Lỗi lấy giá ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi lấy giá ${symbol}`);
        return null;
    }
}
async function placeInitialPairTpslOrders(longPos, shortPos, retries = 3) {
    if (!longPos || !shortPos) {
        addLog("[KILL-PAIR] Lỗi: Thiếu thông tin vị thế LONG hoặc SHORT để đặt TP/SL.");
        return false;
    }
    const symbol = longPos.symbol;
    const details = await getSymbolDetails(symbol);
    if (!details) {
        addLog(`[KILL-PAIR] LỖI: Không lấy được symbol details cho ${symbol}.`);
        return false;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        addLog(`[KILL-PAIR] Đặt TP/SL cho cặp ${symbol} (Lần ${attempt}/${retries})...`);
        try {
            const batchOrders = [
                { symbol, side: 'SELL', positionSide: 'LONG', type: 'TAKE_PROFIT_MARKET', stopPrice: longPos.takeProfitPrice.toFixed(longPos.pricePrecision), closePosition: 'true' },
                { symbol, side: 'SELL', positionSide: 'LONG', type: 'STOP_MARKET', stopPrice: longPos.stopLossPrice.toFixed(longPos.pricePrecision), closePosition: 'true' },
                { symbol, side: 'BUY', positionSide: 'SHORT', type: 'TAKE_PROFIT_MARKET', stopPrice: shortPos.takeProfitPrice.toFixed(shortPos.pricePrecision), closePosition: 'true' },
                { symbol, side: 'BUY', positionSide: 'SHORT', type: 'STOP_MARKET', stopPrice: shortPos.stopLossPrice.toFixed(shortPos.pricePrecision), closePosition: 'true' }
            ];
            const batchOrdersString = JSON.stringify(batchOrders);

            await callSignedAPI('/fapi/v1/batchOrders', 'POST', { batchOrders: batchOrdersString });

            const verificationDelay = 3000;
            addLog(`  -> Yêu cầu đã gửi. Chờ ${verificationDelay / 1000}s để xác thực trên sàn...`);
            await sleep(verificationDelay);

            const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });

            const longTpFound = openOrders.some(o => o.type === 'TAKE_PROFIT_MARKET' && o.positionSide === 'LONG');
            const longSlFound = openOrders.some(o => o.type === 'STOP_MARKET' && o.positionSide === 'LONG');
            const shortTpFound = openOrders.some(o => o.type === 'TAKE_PROFIT_MARKET' && o.positionSide === 'SHORT');
            const shortSlFound = openOrders.some(o => o.type === 'STOP_MARKET' && o.positionSide === 'SHORT');

            if (longTpFound && longSlFound && shortTpFound && shortSlFound) {
                addLog(`  -> XÁC THỰC THÀNH CÔNG: Cả 4 lệnh TP/SL cho cặp ${symbol} đã có trên sàn.`);
                return true;
            } else {
                addLog(`  -> XÁC THỰC THẤT BẠI (Lần ${attempt}): Thiếu lệnh TP/SL.`);
                if (!longTpFound) addLog("    - Thiếu TP cho LONG.");
                if (!longSlFound) addLog("    - Thiếu SL cho LONG.");
                if (!shortTpFound) addLog("    - Thiếu TP cho SHORT.");
                if (!shortSlFound) addLog("    - Thiếu SL cho SHORT.");

                if (attempt < retries) {
                    addLog("  -> Sẽ thử lại sau khi dọn dẹp các lệnh đã đặt một phần...");
                    await cancelAllOpenOrdersForSymbol(symbol);
                    await sleep(1000);
                }
            }
        } catch (err) {
            addLog(`[KILL-PAIR] LỖI trong quá trình đặt TP/SL cặp lệnh (Lần ${attempt}): ${err.msg || err.message}`);
            if (attempt < retries) {
                addLog("  -> Sẽ thử lại sau lỗi...");
                await sleep(1500);
            }
        }
    }

    addLog(`[KILL-PAIR] LỖI NGHIÊM TRỌNG: Không thể đặt và xác thực TP/SL cho cặp ${symbol} sau ${retries} lần thử.`);
    return false;
}
async function placeTpslOrders(position, positionType = 'KILL', retries = 3) {
    if (!position) return false;
    const { symbol, side, takeProfitPrice, stopLossPrice, pricePrecision } = position;
    const details = await getSymbolDetails(symbol);

    if (!details) {
        addLog(`[${positionType}] LỖI: Không lấy được symbol details cho ${symbol} để đặt TP/SL.`);
        await closePosition(symbol, `Lỗi lấy details khi đặt TP/SL`, side);
        return false;
    }
    
    if (positionType !== 'SIDEWAYS') {
        try {
            await cancelAllOpenOrdersForSymbol(symbol);
            await sleep(500); 
        } catch (cancelErr) {
            addLog(`[${positionType}] LƯU Ý: Lỗi khi hủy lệnh cũ cho ${symbol} (có thể bỏ qua): ${cancelErr.msg || cancelErr.message}`);
        }
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        addLog(`[${positionType}] Đặt TP/SL cho ${side} ${symbol} (Lần ${attempt}/${retries})...`);
        addLog(`  -> TP @${takeProfitPrice.toFixed(pricePrecision)}, SL @${stopLossPrice.toFixed(pricePrecision)}`);

        try {
            const batchOrders = [
                { symbol, side: (side === 'LONG' ? 'SELL' : 'BUY'), positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: takeProfitPrice.toFixed(pricePrecision), closePosition: 'true' },
                { symbol, side: (side === 'LONG' ? 'SELL' : 'BUY'), positionSide: side, type: 'STOP_MARKET', stopPrice: stopLossPrice.toFixed(pricePrecision), closePosition: 'true' }
            ];
            const batchOrdersString = JSON.stringify(batchOrders);
            
            await callSignedAPI('/fapi/v1/batchOrders', 'POST', { batchOrders: batchOrdersString });

            const verificationDelay = 3000;
            addLog(`  -> Yêu cầu đã gửi. Chờ ${verificationDelay / 1000}s để xác thực trên sàn...`);
            await sleep(verificationDelay);

            const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
            
            const tpOrderFound = openOrders.find(o => 
                o.type === 'TAKE_PROFIT_MARKET' && 
                o.positionSide === side &&
                Math.abs(parseFloat(o.stopPrice) - takeProfitPrice) < details.tickSize
            );
            const slOrderFound = openOrders.find(o => 
                o.type === 'STOP_MARKET' && 
                o.positionSide === side &&
                Math.abs(parseFloat(o.stopPrice) - stopLossPrice) < details.tickSize
            );

            if (tpOrderFound && slOrderFound) {
                addLog(`  -> XÁC THỰC THÀNH CÔNG: TP/SL cho ${side} ${symbol} đã có trên sàn.`);
                return true;
            } else {
                addLog(`  -> XÁC THỰC THẤT BẠI (Lần ${attempt}): Không tìm thấy đủ TP/SL hoặc giá không khớp.`);
                if (attempt < retries) {
                    addLog("  -> Sẽ thử lại...");
                    if (positionType !== 'SIDEWAYS') {
                       await cancelAllOpenOrdersForSymbol(symbol);
                    }
                    await sleep(1000);
                }
            }

        } catch (err) {
            addLog(`[${positionType}] LỖI TRONG QUÁ TRÌNH ĐẶT TP/SL (Lần ${attempt}): ${err.msg || err.message}`);
            if (err instanceof CriticalApiError && botRunning) {
                await stopBotLogicInternal(`Lỗi nghiêm trọng khi đặt TP/SL trên sàn ${symbol}`);
                return false;
            }
            if (attempt < retries) {
                addLog("  -> Sẽ thử lại sau lỗi...");
                await sleep(1500);
            }
        }
    }

    addLog(`[${positionType}] LỖI NGHIÊM TRỌNG: Không thể đặt và xác thực TP/SL cho ${side} ${symbol} sau ${retries} lần thử.`);
    addLog(`  -> Đóng khẩn cấp vị thế ${side} ${symbol} để đảm bảo an toàn.`);
    await closePosition(symbol, `Lỗi đặt/xác thực TP/SL`, side);
    return false;
}
async function moveStopLossToEntry(position) {
    if (!position || position.hasMovedSLToEntry) {
        return;
    }

    addLog(`[KILL] Vị thế đối lập đã đóng. Dời SL của lệnh ${position.side} về hòa vốn...`);

    try {
        const updatedPositionForOrder = {
            ...position,
            stopLossPrice: position.entryPrice,
        };

        const placed = await placeTpslOrders(updatedPositionForOrder, 'KILL');
        
        if (placed) {
            addLog(`  -> Đã dời SL của ${position.side} về ${position.entryPrice.toFixed(position.pricePrecision)} thành công.`);
            position.stopLossPrice = position.entryPrice;
            position.hasMovedSLToEntry = true;
        } else {
            addLog(`  -> LỖI khi đặt lại TP/SL sau khi dời. Đóng khẩn cấp vị thế ${position.side}.`);
            await closePosition(position.symbol, "Lỗi dời SL về hòa vốn", position.side);
        }

    } catch (err) {
        addLog(`  -> Lỗi nghiêm trọng trong quá trình dời SL về hòa vốn: ${err.msg || err.message}`);
    }
}
async function cancelAllOpenOrdersForSymbol(symbol) {
    if (!symbol) return true;
    addLog(`Hủy TẤT CẢ lệnh chờ ${symbol}...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            addLog(`Không lệnh chờ ${symbol}.`);
            return true;
        }
        addLog(`Tìm thấy ${openOrders.length} lệnh chờ ${symbol}. Đang hủy...`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        addLog(`Đã gửi yêu cầu hủy toàn bộ lệnh chờ cho ${symbol}.`);
        return true;
    } catch (e) {
        if (e.code !== -2011) addLog(`Lỗi hủy DS lệnh chờ ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError && botRunning) {
            await stopBotLogicInternal(`Lỗi hủy DS lệnh chờ ${symbol}`);
            return false;
        }
        return false;
    }
}
async function closePosition(symbol, reason, positionSideToClose) {
    if (!symbol || !positionSideToClose || isProcessingTrade) {
        if (isProcessingTrade) addLog(`closePosition(${symbol}) bỏ qua do isProcessingTrade.`);
        return false;
    }
    isProcessingTrade = true;
    addLog(`Đóng ${positionSideToClose} ${symbol} (Lý do: ${reason})...`);
    let success = false;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === positionSideToClose && parseFloat(p.positionAmt) !== 0);
        if (posOnEx) {
            const qty = Math.abs(parseFloat(posOnEx.positionAmt));
            if (qty === 0) {
                addLog(`Không có vị thế ${positionSideToClose} ${symbol} để đóng.`);
                success = true;
            } else {
                const sideOrder = (positionSideToClose === 'LONG') ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol,
                    side: sideOrder,
                    positionSide: positionSideToClose,
                    type: 'MARKET',
                    quantity: qty,
                    newClientOrderId: `CLOSE-${positionSideToClose[0]}-${Date.now().toString().slice(-10)}`
                });
                addLog(`Đã gửi MARKET đóng ${qty} ${positionSideToClose} ${symbol}.`);
                addLog(`  -> Sàn sẽ tự động hủy các lệnh TP/SL liên quan đến vị thế này.`);

                if (positionSideToClose === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
                else if (positionSideToClose === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;
                success = true;
            }
        } else {
            addLog(`Không tìm thấy vị thế ${positionSideToClose} ${symbol} trên sàn.`);
            success = true;
        }
    } catch (err) {
        addLog(`Lỗi đóng ${positionSideToClose} ${symbol}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đóng ${positionSideToClose} ${symbol}`);
        success = false;
    } finally {
        isProcessingTrade = false;
        return success;
    }
}
async function openMarketPosition(symbol, tradeDirection, maxLeverage, entryPriceOverride = null) {
    addLog(`[${currentBotMode.toUpperCase()}] Mở ${tradeDirection} ${symbol} với ký quỹ ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    let positionObject = null;
    try {
        const details = await getSymbolDetails(symbol);
        if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`);
        if (!await setLeverage(symbol, maxLeverage)) throw new Error(`Lỗi đặt đòn bẩy.`);
        await sleep(200);
        const priceToUseForCalc = entryPriceOverride || await getCurrentPrice(symbol);
        if (!priceToUseForCalc) throw new Error(`Lỗi lấy giá hiện tại/giá ghi đè.`);
        
        let quantity = (INITIAL_INVESTMENT_AMOUNT * maxLeverage) / priceToUseForCalc;
        quantity = parseFloat((Math.floor(quantity / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        
        if (quantity * priceToUseForCalc < details.minNotional) {
            addLog(`Giá trị lệnh ${quantity * priceToUseForCalc} quá nhỏ so với sàn (${details.minNotional}). Tăng vốn hoặc chọn coin khác.`);
            const error = new Error("Giá trị lệnh quá nhỏ so với sàn.");
            error.code = 'INSUFFICIENT_NOTIONAL';
            throw error;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity });
        
        let openPos = null;
        for (let i = 0; i < 15; i++) {
            await sleep(400);
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
            openPos = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) >= quantity * 0.95);
            if (openPos && Math.abs(parseFloat(openPos.positionAmt)) > 0) break;
        }
        if (!openPos || Math.abs(parseFloat(openPos.positionAmt)) === 0) throw new Error("Vị thế MARKET chưa xác nhận trên sàn sau nhiều lần thử.");
        
        const actualEntryPrice = parseFloat(openPos.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPos.positionAmt));
        const actualNotional = actualQuantity * actualEntryPrice;

        addLog(`[${currentBotMode.toUpperCase()}] Mở ${tradeDirection} | KL: ${actualQuantity.toFixed(details.quantityPrecision)} | Giá vào: ${actualEntryPrice.toFixed(details.pricePrecision)}`);
        addLog(`  -> Notional: ${actualNotional.toFixed(2)} USDT, Ký quỹ: ~${INITIAL_INVESTMENT_AMOUNT.toFixed(4)} USDT`);

        let takeProfitPrice, stopLossPrice;

        let TAKE_PROFIT_MULTIPLIER;
        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 12;
        } else {
            TAKE_PROFIT_MULTIPLIER = 6;
        }

        let pnlThresholdPerMilestone;
        if (maxLeverage >= 75) {
            pnlThresholdPerMilestone = INITIAL_INVESTMENT_AMOUNT * 1.00;
        } else {
            pnlThresholdPerMilestone = INITIAL_INVESTMENT_AMOUNT * 0.50;
        }
        
        const targetPnlForTP_USDT = INITIAL_INVESTMENT_AMOUNT * TAKE_PROFIT_MULTIPLIER;
        const targetPnlForSL_USDT = -(pnlThresholdPerMilestone * 6);
        
        const priceChangeUnitForTP = targetPnlForTP_USDT / actualQuantity;
        const priceChangeUnitForSL = Math.abs(targetPnlForSL_USDT) / actualQuantity;

        takeProfitPrice = parseFloat((tradeDirection === 'LONG' ? actualEntryPrice + priceChangeUnitForTP : actualEntryPrice - priceChangeUnitForTP).toFixed(details.pricePrecision));
        stopLossPrice = parseFloat((tradeDirection === 'LONG' ? actualEntryPrice - priceChangeUnitForSL : actualEntryPrice + priceChangeUnitForSL).toFixed(details.pricePrecision));
        
        positionObject = {
            symbol,
            quantity: actualQuantity,
            initialQuantity: actualQuantity,
            entryPrice: actualEntryPrice,
            side: tradeDirection,
            pricePrecision: details.pricePrecision,
            quantityPrecision: details.quantityPrecision,
            takeProfitPrice,
            stopLossPrice,
            unrealizedPnl: 0,
            realizedPnlFromPartials: 0, 
            hasMovedSLToEntry: false,
            leverage: maxLeverage,
            milestoneCounter: 0,
            closedLossAmount: 0,
            pnlThresholdPerMilestone: pnlThresholdPerMilestone
        };
        
        return positionObject;

    } catch (err) {
        addLog(`[${currentBotMode.toUpperCase()}] Lỗi mở ${tradeDirection} ${symbol}: ${err.msg || err.message}`);
        if (err.code === -2019 || err.code === 'INSUFFICIENT_NOTIONAL') {
            err.isMarginError = true;
        }
        if (err.code === -2027) {
            err.shouldBlacklist = true;
        }
        if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi mở ${tradeDirection} ${symbol}`);
        throw err;
    }
}
async function closePartialPosition(position, quantityToClose, milestone = null) {
    if (!position || position.quantity <= 0 || isProcessingTrade || quantityToClose <= 0 || !position.symbol) return false;
    isProcessingTrade = true;
    let success = false;
    try {
        const details = await getSymbolDetails(position.symbol);
        if (!details) throw new Error(`Lỗi lấy chi tiết symbol.`);
        
        let qtyEff = Math.min(quantityToClose, position.quantity);
        qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        
        if (qtyEff <= 0 || qtyEff * (position.currentPrice || position.entryPrice) < details.minNotional * 0.9) {
            addLog(`Lỗi đóng từng phần: Lượng đóng không hợp lệ hoặc quá nhỏ. KL tính toán: ${qtyEff}`);
            success = false;
        } else {
            const sideOrder = (position.side === 'LONG') ? 'SELL' : 'BUY';
            const reasonLog = milestone ? `(Mốc ${milestone})` : '';
            addLog(`[${currentBotMode.toUpperCase()}] Đóng 1 phần ${qtyEff.toFixed(details.quantityPrecision)} ${position.side} ${position.symbol} ${reasonLog}.`);

            const closePrice = position.currentPrice || (await getCurrentPrice(position.symbol)) || position.entryPrice;
            const pnlFromThisClose = (closePrice - position.entryPrice) * qtyEff * (position.side === 'LONG' ? 1 : -1);
            position.realizedPnlFromPartials = (position.realizedPnlFromPartials || 0) + pnlFromThisClose;
            addLog(`  -> PNL ước tính từ lần cắt này: ${pnlFromThisClose.toFixed(2)} USDT. Tổng PNL đã cắt: ${position.realizedPnlFromPartials.toFixed(2)} USDT.`);
            
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: sideOrder,
                positionSide: position.side,
                type: 'MARKET',
                quantity: qtyEff,
                newClientOrderId: `${currentBotMode.toUpperCase()}-PARTIAL-${position.side[0]}${Date.now().toString().slice(-8)}`
            });
            position.quantity -= qtyEff;
            position.closedLossAmount += qtyEff;
            addLog(`  -> KL còn lại của ${position.side} ${position.symbol}: ${position.quantity.toFixed(position.quantityPrecision)}`);
            success = true;
        }
    } catch (err) {
        addLog(`[${currentBotMode.toUpperCase()}] Lỗi đóng từng phần ${position.side}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi đóng từng phần ${position.side}`);
        success = false;
    } finally {
        isProcessingTrade = false;
        return success;
    }
}
async function recoverPartialPosition(position) {
    if (!position || position.closedLossAmount <= 0 || isProcessingTrade) return false;
    isProcessingTrade = true;
    let success = false;
    try {
        addLog(`[PHỤC HỒI VỊ THẾ] Lệnh ${position.side} ${position.symbol} hồi vốn. Mở lại ${position.closedLossAmount} đã cắt.`);
        const details = await getSymbolDetails(position.symbol);
        if (!details) throw new Error('Không có details symbol');

        const quantityToRecover = parseFloat((Math.floor(position.closedLossAmount / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        
        if (quantityToRecover <= 0) {
            addLog(`[PHỤC HỒI VỊ THẾ] Lượng phục hồi tính toán ra 0 hoặc âm. Bỏ qua.`);
            success = true;
        } else {
            const orderSide = (position.side === 'LONG') ? 'BUY' : 'SELL';
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: orderSide,
                positionSide: position.side,
                type: 'MARKET',
                quantity: quantityToRecover
            });
            
            position.quantity += quantityToRecover;
            position.closedLossAmount = 0;
            position.milestoneCounter = 0;
            position.realizedPnlFromPartials = 0; 
            addLog(`  -> Đã mở lại. KL mới của ${position.side}: ${position.quantity.toFixed(position.quantityPrecision)}. Reset mốc cắt lỗ.`);
            success = true;
        }
    } catch(err) {
        addLog(`[PHỤC HỒI VỊ THẾ] Lỗi: ${err.msg || err.message}`);
        success = false;
    } finally {
        isProcessingTrade = false;
        return success;
    }
}
async function openSidewaysGridPosition(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    if (!symbol || isProcessingTrade) return null;
    isProcessingTrade = true;

    try {
        addLog(`LƯỚI: Mở mốc ${tradeDirection} bậc ${stepIndex}, giá mục tiêu ~${entryPriceToTarget.toFixed(4)}`);
        const details = await getSymbolDetails(symbol);
        if (!details) throw new Error(`Lỗi details ${symbol}.`);
        const maxLev = await getLeverageBracketForSymbol(symbol);
        if (!maxLev || maxLev < MIN_LEVERAGE_TO_TRADE) throw new Error(`Đòn bẩy ${maxLev}x < ${MIN_LEVERAGE_TO_TRADE}x.`);
        if (!await setLeverage(symbol, maxLev)) throw new Error(`Lỗi đặt đòn bẩy.`);
        await sleep(200);
        
        let marginForGrid = INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO;
        let qty = (marginForGrid * maxLev) / entryPriceToTarget;
        
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));
        if (qty * entryPriceToTarget < details.minNotional) throw new Error(`Giá trị lệnh lưới ${qty * entryPriceToTarget} USDT quá nhỏ.`);

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        
        const clientOrderId = `GRID-${tradeDirection[0]}${stepIndex}-${Date.now()}`;

        const marketOrderRes = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol,
            side: orderSide,
            positionSide: tradeDirection,
            type: 'MARKET',
            quantity: qty,
            newClientOrderId: clientOrderId,
            newOrderRespType: 'RESULT'
        });

        const actualEntry = parseFloat(marketOrderRes.avgPrice);
        const actualQty = parseFloat(marketOrderRes.executedQty);
        if (actualQty === 0) throw new Error(`Lệnh lưới ${symbol} không khớp KL.`);
        addLog(`LƯỚI: Đã MỞ ${tradeDirection} ${symbol} | KL:${actualQty.toFixed(details.quantityPrecision)}, Giá:${actualEntry.toFixed(details.pricePrecision)}`);

        const takeProfitPrice = parseFloat((actualEntry * (1 + (tradeDirection === 'LONG' ? SIDEWAYS_TP_PRICE_PERCENT : -SIDEWAYS_TP_PRICE_PERCENT))).toFixed(details.pricePrecision));
        const stopLossPrice = parseFloat((actualEntry * (1 - (tradeDirection === 'LONG' ? SIDEWAYS_SL_PRICE_PERCENT : -SIDEWAYS_SL_PRICE_PERCENT))).toFixed(details.pricePrecision));

        const gridPos = {
            id: clientOrderId,
            symbol,
            side: tradeDirection,
            entryPrice: actualEntry,
            quantity: actualQty,
            stepIndex,
            takeProfitPrice,
            stopLossPrice,
            pricePrecision: details.pricePrecision,
            quantityPrecision: details.quantityPrecision
        };
        
        const tpslPlaced = await placeTpslOrders(gridPos, 'SIDEWAYS');
        if (!tpslPlaced) {
            await closePosition(symbol, "Lỗi đặt TP/SL cho lệnh lưới", tradeDirection);
            return null;
        }

        sidewaysGrid.activeGridPositions.push(gridPos);
        sidewaysGrid.hasOpenedGridPositionThisSession = true;
        return gridPos;

    } catch (err) {
        addLog(`LƯỚI: LỖI MỞ LỆNH ${tradeDirection} ${symbol}: ${err.msg || err.message}`);
        if (err.code === -2027) {
            throw err;
        }
        if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi mở lệnh lưới ${tradeDirection} ${symbol}`);
        return null;
    } finally {
        isProcessingTrade = false;
    }
}
async function closeSidewaysGridPosition(gridPosition, reason) {
    if (pendingClosures.has(gridPosition.id)) {
        return false;
    }
    if (!gridPosition || isProcessingTrade) {
        return false;
    }

    pendingClosures.add(gridPosition.id);
    isProcessingTrade = true;

    const { symbol, side, quantity, id } = gridPosition;
    
    const shortId = id.split('-').slice(0, 3).join('-');
    addLog(`LƯỚI: Đóng ${shortId} (${side}). Lý do: ${reason}`);

    let success = false;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === side && parseFloat(p.positionAmt) !== 0);

        if (posOnEx) {
            const qtyToClose = gridPosition.quantity;

            if (qtyToClose === 0) {
                addLog(`  -> Lượng đóng mốc ${shortId} là 0.`);
                success = true;
            } else {
                const sideOrder = (side === 'LONG') ? 'SELL' : 'BUY';
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol,
                    side: sideOrder,
                    positionSide: side,
                    type: 'MARKET',
                    quantity: qtyToClose, 
                    newClientOrderId: `CLOSE-${id}`
                });
                addLog(`  -> Đã gửi MARKET đóng ${qtyToClose} ${side} ${symbol}.`);
                success = true;
            }
        } else {
            addLog(`  -> Không tìm thấy vị thế ${side} ${symbol} trên sàn.`);
            success = true;
        }

    } catch (err) {
        addLog(`LƯỚI: LỖI ĐÓNG MỐC ${shortId}: ${err.msg || err.message}`);
        if (err.code === -2011 || err.code === -2022) {
            addLog(`  -> Lệnh đóng ${shortId} bị từ chối (${err.code}), có thể đã đóng trước đó.`);
            success = true;
        } else {
            success = false;
        }
    } finally {
        if (success) {
            sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== id);
        }
        isProcessingTrade = false;
        setTimeout(() => {
            pendingClosures.delete(gridPosition.id);
        }, 5000);
        return success;
    }
}
async function closeAllSidewaysPositionsAndOrders(reason) {
    if (!TARGET_COIN_SYMBOL) return;
    addLog(`LƯỚI: Dọn dẹp tất cả vị thế Sideways ${TARGET_COIN_SYMBOL}. Lý do: ${reason}`);
    try {
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        await sleep(200);

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        for (const pos of positions) {
            const posAmt = parseFloat(pos.positionAmt);
            if (pos.symbol === TARGET_COIN_SYMBOL && posAmt !== 0) {
                await closePosition(TARGET_COIN_SYMBOL, `Đóng toàn bộ lưới (${pos.positionSide})`, pos.positionSide);
                await sleep(500);
            }
        }
    } catch (e) {
        addLog(`Lỗi khi đóng vị thế lưới còn lại: ${e.msg || e.message}`);
    }

    sidewaysGrid.isActive = false;
    sidewaysGrid.anchorPrice = null;
    sidewaysGrid.activeGridPositions = [];
    sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
    addLog(`LƯỚI: Hoàn tất dọn dẹp Sideways ${TARGET_COIN_SYMBOL}.`);
}
async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || sidewaysGrid.isClearingForSwitch || !TARGET_COIN_SYMBOL || isProcessingTrade) return;

    if (
        sidewaysGrid.sidewaysEntryTimestamp &&
        !sidewaysGrid.hasOpenedGridPositionThisSession &&
        (Date.now() - sidewaysGrid.sidewaysEntryTimestamp > SIDEWAYS_INACTIVITY_TIMEOUT_MS)
    ) {
        addLog(`LƯỚI: Không có lệnh nào được mở sau 15 phút. Coin ${TARGET_COIN_SYMBOL} có thể không hoạt động.`);
        await handleCoinSwitch(`Không hoạt động sau 15 phút`, true);
        return;
    }
    
    const { anchorPrice, activeGridPositions } = sidewaysGrid;
    if (!anchorPrice) return;
    if (isProcessingTrade) return;

    const MAX_STEPS = 10;
    
    for (let i = 1; i <= MAX_STEPS; i++) {
        if (isProcessingTrade) break;

        const shortTrig = anchorPrice * (1 + i * SIDEWAYS_GRID_STEP_PERCENT);
        const isShortStepOpen = activeGridPositions.some(p => p.side === 'SHORT' && p.stepIndex === i);
        if (currentMarketPrice >= shortTrig && !isShortStepOpen) {
            addLog(`LƯỚI: Giá chạm ngưỡng SHORT bậc ${i}.`);
            await openSidewaysGridPosition(TARGET_COIN_SYMBOL, 'SHORT', shortTrig, i);
            await sleep(500);
        }

        const longTrig = anchorPrice * (1 - i * SIDEWAYS_GRID_STEP_PERCENT);
        const isLongStepOpen = activeGridPositions.some(p => p.side === 'LONG' && p.stepIndex === i);
        if (currentMarketPrice <= longTrig && !isLongStepOpen) {
            addLog(`LƯỚI: Giá chạm ngưỡng LONG bậc ${i}.`);
            await openSidewaysGridPosition(TARGET_COIN_SYMBOL, 'LONG', longTrig, i);
            await sleep(500);
        }
    }

    const upperBoundaryTrigger = anchorPrice * (1 + (MAX_STEPS + 0.5) * SIDEWAYS_GRID_STEP_PERCENT);
    const lowerBoundaryTrigger = anchorPrice * (1 - (MAX_STEPS + 0.5) * SIDEWAYS_GRID_STEP_PERCENT);

    if (currentMarketPrice > upperBoundaryTrigger || currentMarketPrice < lowerBoundaryTrigger) {
        const newAnchorStep = Math.round((currentMarketPrice / anchorPrice - 1) / SIDEWAYS_GRID_STEP_PERCENT);
        if (newAnchorStep !== 0) {
            const newAnchorPrice = anchorPrice * (1 + newAnchorStep * SIDEWAYS_GRID_STEP_PERCENT);
            addLog(`LƯỚI: Giá vượt biên. Trượt khung lưới.`);
            addLog(`  -> Anchor Price mới: ${newAnchorPrice.toFixed(4)} (từ ${anchorPrice.toFixed(4)})`);
            sidewaysGrid.anchorPrice = newAnchorPrice;
        }
    }

    if (Date.now() - (sidewaysGrid.lastCheckTime || 0) > SIDEWAYS_CHECK_INTERVAL_MS) {
        sidewaysGrid.lastCheckTime = Date.now();
        await fetchAndCacheTopCoinsFromVPS1(true);
        const currentCoinData = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
        const currentCoinVol = currentCoinData ? Math.abs(currentCoinData.changePercent) : 0;

        if (currentCoinVol >= OVERALL_VOLATILITY_THRESHOLD_VPS1) {
            addLog(`LƯỚI->KILL: Vol ${TARGET_COIN_SYMBOL} (${currentCoinVol.toFixed(2)}%) tăng vượt ngưỡng ${OVERALL_VOLATILITY_THRESHOLD_VPS1.toFixed(2)}%. Chuyển sang Kill.`);
            sidewaysGrid.isClearingForSwitch = true;
            await closeAllSidewaysPositionsAndOrders("Chuyển sang Kill do Vol tăng");
            if (sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
            sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                currentBotMode = 'kill';
                sidewaysGrid.isClearingForSwitch = false;
                if (botRunning) scheduleNextMainCycle(1000);
            }, MODE_SWITCH_DELAY_MS);
            return;
        }
        
        const bestAlternativeCoin = vps1DataCache.find(c => c.symbol !== TARGET_COIN_SYMBOL && !blacklistedCoinsThisSession.has(c.symbol));
        if (bestAlternativeCoin) {
            const altCoinVol = Math.abs(bestAlternativeCoin.changePercent);
            const isVolDifferenceSufficient = altCoinVol > (currentCoinVol + MIN_VOLATILITY_DIFFERENCE_TO_SWITCH);

            if (isVolDifferenceSufficient) {
                addLog(`LƯỚI->KILL: Đổi sang coin tốt hơn ${bestAlternativeCoin.symbol} (Vol: ${altCoinVol.toFixed(2)}%) so với ${TARGET_COIN_SYMBOL} (Vol: ${currentCoinVol.toFixed(2)}%).`);
                sidewaysGrid.isClearingForSwitch = true;
                await closeAllSidewaysPositionsAndOrders(`Chuyển sang coin tốt hơn ${bestAlternativeCoin.symbol}`);
                if (sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
                sidewaysGrid.switchDelayTimeout = setTimeout(async () => {
                    sidewaysGrid.isClearingForSwitch = false;
                    currentBotMode = 'kill';
                    if (botRunning) scheduleNextMainCycle(1000);
                }, COIN_SWITCH_DELAY_MS);
                return;
            }
        }
    }
}
async function checkOverallTPSL() {
    if (!botRunning || isProcessingTrade || pendingClosures.size > 0) return false;
    
    let currentTrueOverallPnl = cumulativeRealizedPnlSinceStart;
    if (currentLongPosition) {
        currentTrueOverallPnl += (currentLongPosition.unrealizedPnl || 0) + (currentLongPosition.realizedPnlFromPartials || 0);
    }
    if (currentShortPosition) {
        currentTrueOverallPnl += (currentShortPosition.unrealizedPnl || 0) + (currentShortPosition.realizedPnlFromPartials || 0);
    }

    if (sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0 && currentMarketPrice && TARGET_COIN_SYMBOL) {
        for (const pos of sidewaysGrid.activeGridPositions) {
            currentTrueOverallPnl += (currentMarketPrice - pos.entryPrice) * pos.quantity * (pos.side === 'LONG' ? 1 : -1);
        }
    }
    if (overallTakeProfit > 0 && currentTrueOverallPnl >= overallTakeProfit) {
        addLog(`[OVERALL TP] PNL Tổng (${currentTrueOverallPnl.toFixed(2)}) đạt mục tiêu TP (${overallTakeProfit.toFixed(2)}). Dừng bot.`);
        await stopBotLogicInternal(`Overall TP Reached: ${currentTrueOverallPnl.toFixed(2)} >= ${overallTakeProfit.toFixed(2)}`);
        return true;
    }
    if (overallStopLoss < 0 && currentTrueOverallPnl <= overallStopLoss) {
        addLog(`[OVERALL SL] PNL Tổng (${currentTrueOverallPnl.toFixed(2)}) đạt mục tiêu SL (${overallStopLoss.toFixed(2)}). Dừng bot.`);
        await stopBotLogicInternal(`Overall SL Reached: ${currentTrueOverallPnl.toFixed(2)} <= ${overallStopLoss.toFixed(2)}`);
        return true;
    }
    return false;
}
async function handleCoinSwitch(reason, shouldBlacklist = false) {
    addLog(`[CHUYỂN COIN] Lý do: ${reason}`);
    const currentCoin = TARGET_COIN_SYMBOL;

    await releaseCoinOnServer(currentCoin);

    if (currentCoin && shouldBlacklist) {
        blacklistedCoinsThisSession.add(currentCoin);
        addLog(`[BLACKLIST] Đã thêm ${currentCoin} vào danh sách loại trừ.`);
    }

    if (currentBotMode === 'sideways') {
        await closeAllSidewaysPositionsAndOrders(`Chuyển coin: ${reason}`);
    } else if (currentBotMode === 'kill') {
        if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển coin: ${reason}`, 'LONG');
        if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển coin: ${reason}`, 'SHORT');
    }
    
    await cancelAllOpenOrdersForSymbol(currentCoin);

    TARGET_COIN_SYMBOL = null;
    currentLongPosition = null;
    currentShortPosition = null;
    isAdjustmentInProgress = false;
    sidewaysGrid.isActive = false;

    if (botRunning) {
        scheduleNextMainCycle(1000);
    }
}
async function runTradingLogic() {
    if (!botRunning || isProcessingTrade || sidewaysGrid.isClearingForSwitch || isOpeningInitialPair || pendingClosures.size > 0) {
        if (pendingClosures.size > 0) addLog("Chờ xử lý PNL, tạm dừng chu kỳ mới.");
        return;
    }
    if (await checkOverallTPSL()) return;

    let initialVolatility = 0;

    const needsNewCoin = !TARGET_COIN_SYMBOL || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive);
    if (needsNewCoin) {
        const newCoinData = await selectTargetCoin(!TARGET_COIN_SYMBOL);
        if (newCoinData && newCoinData.symbol) {
            const newCoinSymbol = newCoinData.symbol;
            initialVolatility = newCoinData.volatility;

            const claimed = await claimCoinOnServer(newCoinSymbol);
            if (!claimed) {
                addLog("Không thể chiếm coin trên server, thử lại sau 1 phút.");
                if (botRunning) scheduleNextMainCycle(60000);
                return;
            }

            const oldCoin = TARGET_COIN_SYMBOL;
            if (oldCoin !== newCoinSymbol) {
                addLog(`TARGET_COIN đổi từ ${oldCoin || 'N/A'} sang ${newCoinSymbol}.`);
                TARGET_COIN_SYMBOL = newCoinSymbol;
                if (marketWs) {
                    marketWs.removeAllListeners();
                    marketWs.terminate();
                    marketWs = null;
                }
                setupMarketDataStream(TARGET_COIN_SYMBOL);
                if (oldCoin) await cleanupAndResetCycle(oldCoin, true, true);
            }
            
            totalProfit = 0;
            totalLoss = 0;
            netPNL = 0;
            currentLongPosition = null;
            currentShortPosition = null;
            isAdjustmentInProgress = false;
            sidewaysGrid = { isActive: false, anchorPrice: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastCheckTime: 0, isClearingForSwitch: false, switchDelayTimeout: null, sidewaysEntryTimestamp: null, hasOpenedGridPositionThisSession: false };

        } else {
            addLog("Không chọn được coin mục tiêu. Thử lại sau 1 phút.");
            if (botRunning) scheduleNextMainCycle(60000);
            return;
        }
    }

    if (!TARGET_COIN_SYMBOL) {
        if (botRunning) scheduleNextMainCycle(60000);
        return;
    }

    if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive) {
        if (initialVolatility === 0) {
            const currentCoinDataVPS1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
            initialVolatility = currentCoinDataVPS1 ? Math.abs(currentCoinDataVPS1.changePercent) : 0;
        }

        if (initialVolatility >= OVERALL_VOLATILITY_THRESHOLD_VPS1) {
            currentBotMode = 'kill';
        } else {
            currentBotMode = 'sideways';
        }
        addLog(`Bắt đầu chu kỳ ${currentBotMode.toUpperCase()} cho ${TARGET_COIN_SYMBOL} (Vol ban đầu: ${initialVolatility.toFixed(2)}%)...`);
    }

    if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive && !sidewaysGrid.isClearingForSwitch && !isOpeningInitialPair) {
        if (currentBotMode === 'kill') {
            isOpeningInitialPair = true;
            isAdjustmentInProgress = false;
            try {
                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                await sleep(500);

                const maxLev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
                if (!maxLev || maxLev < MIN_LEVERAGE_TO_TRADE) {
                    await handleCoinSwitch(`Đòn bẩy không đủ (${maxLev}x)`, true);
                    isOpeningInitialPair = false;
                    return;
                }
                const priceNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL);
                if (!priceNewPair) {
                    isOpeningInitialPair = false;
                    if (botRunning) scheduleNextMainCycle();
                    return;
                }

                currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLev, priceNewPair);
                if (!currentLongPosition) {
                    isOpeningInitialPair = false;
                    if (botRunning) scheduleNextMainCycle();
                    return;
                }
                await sleep(800);
                currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLev, priceNewPair);
                if (!currentShortPosition) {
                    if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT cặp Kill', 'LONG');
                    currentLongPosition = null;
                    isOpeningInitialPair = false;
                    if (botRunning) scheduleNextMainCycle();
                    return;
                }
                
                addLog("Chờ 3s để ổn định giá trước khi đặt TP/SL trên sàn...");
                await sleep(3000);
                
                const placedSuccessfully = await placeInitialPairTpslOrders(currentLongPosition, currentShortPosition);
                
                if (!placedSuccessfully) {
                    addLog("LỖI: Không thể đặt TP/SL ban đầu cho cặp lệnh. Đóng cả hai vị thế để đảm bảo an toàn.");
                    if (currentLongPosition) await closePosition(currentLongPosition.symbol, "Lỗi đặt TP/SL ban đầu", "LONG");
                    if (currentShortPosition) await closePosition(currentShortPosition.symbol, "Lỗi đặt TP/SL ban đầu", "SHORT");
                    currentLongPosition = null;
                    currentShortPosition = null;
                    isOpeningInitialPair = false;
                    if (botRunning) scheduleNextMainCycle();
                    return;
                }

                lastKillModeCheckTime = Date.now();
                isOpeningInitialPair = false;
            } catch (err) {
                if (err.isMarginError) {
                    await stopBotLogicInternal("Lỗi Margin Insufficient. Dừng bot theo yêu cầu.");
                    return; 
                }
                if (err.shouldBlacklist) {
                    await handleCoinSwitch(`Lỗi vượt khối lượng khi mở cặp KILL`, true);
                } else {
                    addLog(`Lỗi mở cặp Kill: ${err.msg || err.message}`);
                    if (err instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi mở cặp Kill ${TARGET_COIN_SYMBOL}`);
                }
                currentLongPosition = null;
                currentShortPosition = null;
                isOpeningInitialPair = false;
                if(botRunning) scheduleNextMainCycle();
            }
        } else if (currentBotMode === 'sideways') {
            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            await sleep(500);
            const priceAnchor = await getCurrentPrice(TARGET_COIN_SYMBOL);
            if (!priceAnchor) {
                if (botRunning) scheduleNextMainCycle();
                return;
            }
            const details = await getSymbolDetails(TARGET_COIN_SYMBOL);
            if (!details) {
                if (botRunning) scheduleNextMainCycle();
                return;
            }
            sidewaysGrid.isActive = true;
            sidewaysGrid.anchorPrice = priceAnchor;
            sidewaysGrid.lastCheckTime = Date.now();
            sidewaysGrid.activeGridPositions = [];
            sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
            sidewaysGrid.sidewaysEntryTimestamp = Date.now();
            sidewaysGrid.hasOpenedGridPositionThisSession = false;
            addLog(`LƯỚI: Đã thiết lập Anchor Price tại ${priceAnchor.toFixed(details.pricePrecision)}. Bắt đầu theo dõi 15 phút không hoạt động.`);
        }
    }

    if (botRunning && !nextScheduledCycleTimeout) scheduleNextMainCycle();
    if (botRunning && !positionCheckInterval && (currentLongPosition || currentShortPosition || sidewaysGrid.isActive)) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        const checkIntervalMs = currentBotMode === 'kill' ? 5000 : (sidewaysGrid.isActive ? 3000 : 7000);
        
        positionCheckInterval = setInterval(async () => {
            if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForSwitch && !isOpeningInitialPair) {
                try {
                    await manageOpenPosition();
                } catch (e) {
                    addLog(`Lỗi interval manageOpenPosition: ${e.msg || e.message}`);
                    if (e instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi interval manageOpenPosition`);
                }
            } else if ((!botRunning || sidewaysGrid.isClearingForSwitch || isOpeningInitialPair) && positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
        }, checkIntervalMs);
    } else if ((!botRunning || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive)) && positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
}
async function manageOpenPosition() {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForSwitch || !TARGET_COIN_SYMBOL || isOpeningInitialPair || pendingClosures.size > 0) return;

    if (currentBotMode === 'kill' && Date.now() - lastKillModeCheckTime > KILL_MODE_SWITCH_CHECK_INTERVAL_MS) {
        lastKillModeCheckTime = Date.now();
        await fetchAndCacheTopCoinsFromVPS1(true);
        const currentCoinData = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
        const currentCoinVol = currentCoinData ? Math.abs(currentCoinData.changePercent) : 0;
        
        const bestAlternativeCoin = vps1DataCache
            .filter(c => c.symbol !== TARGET_COIN_SYMBOL && !blacklistedCoinsThisSession.has(c.symbol))
            .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))[0];

        if (bestAlternativeCoin) {
            const altCoinVol = Math.abs(bestAlternativeCoin.changePercent);
            const isAltVolSufficientlyHigh = altCoinVol > 10.0;
            const isVolDifferenceSufficient = altCoinVol > (currentCoinVol + 5.0);

            if (isAltVolSufficientlyHigh && isVolDifferenceSufficient) {
                const hasExistingPos = await checkExistingPosition(bestAlternativeCoin.symbol);
                if (!hasExistingPos) {
                    const reason = `Chuyển sang cơ hội tốt hơn ${bestAlternativeCoin.symbol} (Vol: ${altCoinVol.toFixed(2)}% > 15% và hơn ${currentCoinVol.toFixed(2)}% ít nhất 5%)`;
                    await handleCoinSwitch(reason);
                    return; 
                }
            }
        }
    }

    if (await checkOverallTPSL()) return;

    if (currentBotMode === 'kill') {
        try {
            const positionsData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            let longPosEx = positionsData.find(p => p.positionSide === 'LONG' && p.symbol === TARGET_COIN_SYMBOL);
            let shortPosEx = positionsData.find(p => p.positionSide === 'SHORT' && p.symbol === TARGET_COIN_SYMBOL);
            
            if (currentLongPosition) {
                if (longPosEx && Math.abs(parseFloat(longPosEx.positionAmt)) > 0) {
                    currentLongPosition.unrealizedPnl = parseFloat(longPosEx.unRealizedProfit);
                    currentLongPosition.quantity = Math.abs(parseFloat(longPosEx.positionAmt));
                } else {
                    currentLongPosition = null; 
                }
            }
            if (currentShortPosition) {
                if (shortPosEx && Math.abs(parseFloat(shortPosEx.positionAmt)) > 0) {
                    currentShortPosition.unrealizedPnl = parseFloat(shortPosEx.unRealizedProfit);
                    currentShortPosition.quantity = Math.abs(parseFloat(shortPosEx.positionAmt));
                } else {
                    currentShortPosition = null;
                }
            }
        } catch (err) {
            addLog(`Lỗi cập nhật PNL ảo (Kill): ${err.msg || err.message}`);
            if (err instanceof CriticalApiError) await stopBotLogicInternal(`Lỗi cập nhật vị thế (Kill) ${TARGET_COIN_SYMBOL}`);
            return;
        }

        if (currentLongPosition && currentShortPosition && !isAdjustmentInProgress) {
            let winner, loser;
            if (currentLongPosition.unrealizedPnl >= currentShortPosition.unrealizedPnl) {
                winner = currentLongPosition;
                loser = currentShortPosition;
            } else {
                winner = currentShortPosition;
                loser = currentLongPosition;
            }

            const pnlThreshold = loser.pnlThresholdPerMilestone;
            if (pnlThreshold) {
                const pnlForMilestone5 = -(pnlThreshold * 5);

                if (loser.unrealizedPnl <= pnlForMilestone5) {
                    isAdjustmentInProgress = true;
                    isProcessingTrade = true;
                    addLog(`[ĐIỀU CHỈNH] Lệnh lỗ ${loser.side} đạt mốc 5. PNL: ${loser.unrealizedPnl.toFixed(2)} <= ${pnlForMilestone5.toFixed(2)}. Bắt đầu điều chỉnh cả 2 lệnh.`);

                    try {
                        const pnlForSlMilestone8 = -(pnlThreshold * 8);
                        const priceChangeForSl8 = pnlForSlMilestone8 / loser.initialQuantity;
                        const newLoserSlPrice = parseFloat((loser.side === 'LONG' ? loser.entryPrice + priceChangeForSl8 : loser.entryPrice - priceChangeForSl8).toFixed(loser.pricePrecision));
                        const newLoserTpPrice = loser.entryPrice; 

                        const loserAdjustedPos = { ...loser, takeProfitPrice: newLoserTpPrice, stopLossPrice: newLoserSlPrice };
                        
                        const newWinnerSlPrice = winner.entryPrice;
                        const winnerAdjustedPos = { ...winner, stopLossPrice: newWinnerSlPrice };

                        addLog(`  -> [Lệnh Lỗ ${loser.side}] Dời TP về hòa vốn (${newLoserTpPrice.toFixed(loser.pricePrecision)}) và SL về mốc 8 (${newLoserSlPrice.toFixed(loser.pricePrecision)}).`);
                        addLog(`  -> [Lệnh Lãi ${winner.side}] Dời SL về hòa vốn: ${newWinnerSlPrice.toFixed(winner.pricePrecision)}`);

                        const placedLoser = await placeTpslOrders(loserAdjustedPos, 'ADJUST-LOSER');
                        if (!placedLoser) throw new Error(`Không thể đặt TP/SL mới cho lệnh lỗ ${loser.side}.`);
                        loser.takeProfitPrice = newLoserTpPrice;
                        loser.stopLossPrice = newLoserSlPrice;
                        
                        await sleep(500);

                        const placedWinner = await placeTpslOrders(winnerAdjustedPos, 'ADJUST-WINNER');
                        if (!placedWinner) throw new Error(`Không thể đặt TP/SL mới cho lệnh lãi ${winner.side}.`);
                        winner.stopLossPrice = newWinnerSlPrice;
                        winner.hasMovedSLToEntry = true;

                    } catch (e) {
                        addLog(`  -> LỖI trong quá trình điều chỉnh lệnh: ${e.msg || e.message}. Đóng khẩn cấp cả 2 vị thế.`);
                        await closePosition(winner.symbol, "Lỗi điều chỉnh lệnh", winner.side);
                        await closePosition(loser.symbol, "Lỗi điều chỉnh lệnh", loser.side);
                    } finally {
                        isProcessingTrade = false;
                    }
                }
            }
        }
        
        const positionsToCheck = [currentLongPosition, currentShortPosition];
        for (const pos of positionsToCheck) {
            if (!pos || pendingClosures.size > 0 || isAdjustmentInProgress) continue;
            
            if (pos.closedLossAmount > 0 && pos.unrealizedPnl >= 0) {
                await recoverPartialPosition(pos);
                continue;
            }
            
            if (pos.unrealizedPnl < 0) {
                const pnlThreshold = pos.pnlThresholdPerMilestone;
                if (!pnlThreshold) continue;

                const targetPnlForNextLossMilestone = -(pnlThreshold * (pos.milestoneCounter + 1));
                
                if (pos.unrealizedPnl <= targetPnlForNextLossMilestone) {
                    const nextMilestone = pos.milestoneCounter + 1;

                    if (nextMilestone === 8) {
                        addLog(`[CẮT LỖ CUỐI CÙNG] Vị thế ${pos.side} (L${pos.leverage}x) đạt mốc lỗ ${nextMilestone}. PNL: ${pos.unrealizedPnl.toFixed(2)} <= ${targetPnlForNextLossMilestone.toFixed(2)}. Đóng toàn bộ.`);
                        await closePosition(pos.symbol, `Đạt mốc lỗ cuối cùng (${nextMilestone})`, pos.side);
                    } else if (nextMilestone < 8) {
                        addLog(`[CẮT LỖ MILESTONE] Vị thế ${pos.side} (L${pos.leverage}x) đạt mốc lỗ ${nextMilestone}. PNL: ${pos.unrealizedPnl.toFixed(2)} <= ${targetPnlForNextLossMilestone.toFixed(2)}.`);
                        
                        const quantityToClose = pos.initialQuantity * 0.10;
                        const closed = await closePartialPosition(pos, quantityToClose, nextMilestone);
                        
                        if (closed) {
                            pos.milestoneCounter++;
                        }
                    }
                }
            }
        }
        
        if (currentLongPosition && !currentShortPosition) {
            await moveStopLossToEntry(currentLongPosition);
        } 
        else if (!currentLongPosition && currentShortPosition) {
            await moveStopLossToEntry(currentShortPosition);
        }
        
        if (!currentLongPosition && !currentShortPosition) {
            addLog("KILL: Cả 2 vị thế đã đóng. Reset chu kỳ...");
            if (botRunning) await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            return;
        }

    } else if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        try {
            await manageSidewaysGridLogic();
        } catch (err) {
            if (err.code === -2027) {
                await handleCoinSwitch(`Lỗi vượt khối lượng khi mở mốc lưới`, true);
            } else {
                addLog(`Lỗi manageSidewaysGridLogic: ${err.msg || err.message}`);
            }
        }
    }
}
async function handleFinalClosure(orderId, clientOrderId, symbol, lastKnownPnl, orderType) {
    let gridIdToClear = null;
    if (clientOrderId && clientOrderId.startsWith('GRID-')) {
         gridIdToClear = clientOrderId;
    }
    
    if (sidewaysGrid.isActive && !gridIdToClear) {
        const positionsAfterCheck = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        for (const pos of sidewaysGrid.activeGridPositions) {
            const correspondingPosOnExchange = positionsAfterCheck.find(p => p.positionSide === pos.side);
            if (!correspondingPosOnExchange || parseFloat(correspondingPosOnExchange.positionAmt) === 0) {
                gridIdToClear = pos.id;
                break;
            }
        }
    }

    try {
        const trades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, orderId: orderId });
        let totalRealizedPnlFromFills = 0;
        if (trades && trades.length > 0) {
            for (const trade of trades) {
                totalRealizedPnlFromFills += parseFloat(trade.realizedPnl);
            }
        } else {
            addLog(`PNL WARN: Không tìm thấy giao dịch cho OrderID ${orderId}. Dùng PNL từ tin nhắn: ${lastKnownPnl.toFixed(4)}`);
            totalRealizedPnlFromFills = lastKnownPnl;
        }

        if (totalRealizedPnlFromFills !== 0) {
            if (totalRealizedPnlFromFills > 0) totalProfit += totalRealizedPnlFromFills;
            else totalLoss += Math.abs(totalRealizedPnlFromFills);
            netPNL = totalProfit - totalLoss;
            cumulativeRealizedPnlSinceStart += totalRealizedPnlFromFills;
            
            const finalLog = `PNL CHỐT (Giao dịch cuối): ${totalRealizedPnlFromFills.toFixed(2)} USDT. PNL Ròng(${symbol}): ${netPNL.toFixed(2)}. PNL Tổng: ${cumulativeRealizedPnlSinceStart.toFixed(2)}`;
            addLog(finalLog);
        }

        await sleep(500);
        const positionsAfter = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbol });
        const longPosAfter = positionsAfter.find(p => p.positionSide === 'LONG');
        const shortPosAfter = positionsAfter.find(p => p.positionSide === 'SHORT');

        const wasLongClosed = currentLongPosition && (!longPosAfter || parseFloat(longPosAfter.positionAmt) === 0);
        const wasShortClosed = currentShortPosition && (!shortPosAfter || parseFloat(shortPosAfter.positionAmt) === 0);
        
        let sideThatWasClosed = null;
        if (wasLongClosed) sideThatWasClosed = 'LONG';
        if (wasShortClosed) sideThatWasClosed = 'SHORT';


        if (sidewaysGrid.isActive && gridIdToClear) {
            const oldLength = sidewaysGrid.activeGridPositions.length;
            sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== gridIdToClear);
            if(sidewaysGrid.activeGridPositions.length < oldLength){
                 addLog(`  -> Đã xóa mốc lưới ${gridIdToClear} khỏi bộ nhớ.`);
                 if (totalRealizedPnlFromFills >= 0) sidewaysGrid.sidewaysStats.tpMatchedCount++;
                 else sidewaysGrid.sidewaysStats.slMatchedCount++;
            }
        }

        if (currentBotMode === 'kill' && sideThatWasClosed) {
            if (sideThatWasClosed === 'LONG') currentLongPosition = null;
            if (sideThatWasClosed === 'SHORT') currentShortPosition = null;

            const remainingPos = currentLongPosition || currentShortPosition;
            const isTpEvent = orderType.includes('TAKE_PROFIT');

            if (remainingPos) {
                if (isTpEvent && totalRealizedPnlFromFills > 0) {
                    addLog(`KILL: Lệnh ${sideThatWasClosed} đã TP. Đóng nốt lệnh ${remainingPos.side} còn lại.`);
                    await closePosition(remainingPos.symbol, `Đóng theo lệnh TP`, remainingPos.side);
                } else if (!isAdjustmentInProgress) {
                    addLog(`KILL: Lệnh ${sideThatWasClosed} đã đóng (SL/Liquid). Dời SL của lệnh ${remainingPos.side} về hòa vốn.`);
                    await moveStopLossToEntry(remainingPos);
                }
            }
        }
        
        if (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive) {
            await cleanupAndResetCycle(symbol);
        }

        if (orderId) pendingClosures.delete(orderId);
        if (clientOrderId) pendingClosures.delete(clientOrderId);
        if (gridIdToClear) pendingClosures.delete(gridIdToClear);

    } catch (err) {
        addLog(`PNL CHECK Lỗi: ${err.msg || err.message}`);
        if (orderId) pendingClosures.delete(orderId);
        if (clientOrderId) pendingClosures.delete(clientOrderId);
        if (gridIdToClear) pendingClosures.delete(gridIdToClear);
        if (err instanceof CriticalApiError) await stopBotLogicInternal("Lỗi API khi kiểm tra PNL cuối cùng");
        await cleanupAndResetCycle(symbol);
    } finally {
        isProcessingTrade = false;
    }
}
async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, c: clientOrderId, ot: orderType } = orderInfo;

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED') return;
    if (pendingClosures.has(orderId) || pendingClosures.has(clientOrderId)) return;

    const isClosureEvent = orderType === 'TAKE_PROFIT_MARKET' || orderType === 'STOP_MARKET' || orderType === 'LIQUIDATION' || (clientOrderId && clientOrderId.startsWith('CLOSE-'));
    const isGridPositionMarketOrder = clientOrderId && clientOrderId.startsWith('GRID-');

    if (isClosureEvent) {
        const realizedPnl = parseFloat(realizedPnlStr);
        addLog(`FILLED: Lệnh đóng (${orderType}) ${orderId} khớp, PNL tin nhắn: ${realizedPnl.toFixed(4)}. Xử lý PNL cuối cùng sau 5s...`);
        pendingClosures.add(orderId);
        if (clientOrderId) pendingClosures.add(clientOrderId);
        setTimeout(() => handleFinalClosure(orderId, clientOrderId, symbol, realizedPnl, orderType), 5000);
    } else if (isGridPositionMarketOrder) {
    }
}
async function cleanupAndResetCycle(symbolToCleanup, isSwitchingCoin = false, noReschedule = false) {
    if (!symbolToCleanup && TARGET_COIN_SYMBOL) symbolToCleanup = TARGET_COIN_SYMBOL;
    if (!symbolToCleanup) {
        return;
    }
    addLog(`Chu kỳ cho ${symbolToCleanup} kết thúc. Dọn dẹp...`);

    await releaseCoinOnServer(symbolToCleanup);

    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    await cancelAllOpenOrdersForSymbol(symbolToCleanup);

    if (symbolToCleanup === TARGET_COIN_SYMBOL || !TARGET_COIN_SYMBOL) {
        currentLongPosition = null;
        currentShortPosition = null;
        isAdjustmentInProgress = false;
        sidewaysGrid.isActive = false;
        if (sidewaysGrid.isClearingForSwitch) {
            addLog("  Đang dọn lưới/chuyển mode, không schedule lại từ cleanup.");
            return;
        }
    }

    isOpeningInitialPair = false;
    if (botRunning && !sidewaysGrid.isClearingForSwitch && !noReschedule) {
        const delay = isSwitchingCoin ? COIN_SWITCH_DELAY_MS : 1000;
        addLog(`  Lên lịch chu kỳ tiếp theo sau ${delay / 1000} giây.`);
        scheduleNextMainCycle(delay);
    }
}
async function startBotLogicInternal() {
    if (botRunning) return 'Bot đã chạy.';
    if (!API_KEY || !SECRET_KEY || API_KEY === 'YOUR_BINANCE_API_KEY') return 'Lỗi: Thiếu API_KEY hoặc SECRET_KEY hợp lệ.';
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
    }
    addLog('--- Khởi động Bot ---');
    try {
        await syncServerTime();
        await getExchangeInfo();
        await fetchAndCacheTopCoinsFromVPS1();

        cumulativeRealizedPnlSinceStart = 0;
        isProcessingTrade = false;
        consecutiveApiErrors = 0;
        isOpeningInitialPair = false;
        isAdjustmentInProgress = false;
        pendingClosures.clear();
        blacklistedCoinsThisSession.clear();

        listenKey = await getListenKey();
        if (listenKey) {
            setupUserDataStream(listenKey);
        } else {
            addLog("Không lấy được listenKey ban đầu. User Stream không thể bắt đầu.");
            throw new Error("Không thể lấy listenKey ban đầu.");
        }

        botRunning = true;
        botStartTime = new Date();
        
        if (statusUpdateInterval) clearInterval(statusUpdateInterval);
        statusUpdateInterval = setInterval(updateStatusCache, STATUS_UPDATE_INTERVAL_MS);

        setInterval(updateStatusOnServer, STATUS_UPDATE_INTERVAL_MS + 500);

        addLog(`--- Bot đã khởi động: ${formatTimeUTC7(botStartTime)} ---`);
        scheduleNextMainCycle(1000);
        return 'Bot khởi động thành công.';
    } catch (err) {
        const errorMsg = err.msg || err.message || 'Lỗi không xác định khi khởi động';
        addLog(`Lỗi nghiêm trọng khi khởi động: ${errorMsg}`);
        botRunning = false;
        if (!(err instanceof CriticalApiError && (errorMsg.includes("API_KEY") || errorMsg.includes("SECRET_KEY") || errorMsg.includes("listenKey"))) && !retryBotTimeout) {
            addLog(`Thử khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => {
                retryBotTimeout = null;
                await startBotLogicInternal();
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động: ${errorMsg}.`;
    }
}
async function stopBotLogicInternal(reason = "Lệnh dừng thủ công") {
    if (!botRunning && !retryBotTimeout) return 'Bot không chạy hoặc không đang retry.';
    addLog(`--- Dừng Bot (Lý do: ${reason}) ---`);
    botRunning = false;
    botStartTime = null;

    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
    }
    updateStatusCache();

    isOpeningInitialPair = false;
    isAdjustmentInProgress = false;
    if (nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = null;
    if (positionCheckInterval) clearInterval(positionCheckInterval);
    positionCheckInterval = null;
    if (sidewaysGrid.switchDelayTimeout) clearTimeout(sidewaysGrid.switchDelayTimeout);
    sidewaysGrid.switchDelayTimeout = null;
    sidewaysGrid.isClearingForSwitch = false;

    if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
    listenKeyRefreshInterval = null;
    if (marketWs) {
        marketWs.removeAllListeners();
        marketWs.terminate();
        marketWs = null;
        addLog("Market Stream đã đóng.");
    }
    if (userDataWs) {
        userDataWs.removeAllListeners();
        userDataWs.terminate();
        userDataWs = null;
        addLog("User Stream đã đóng.");
    }
    if (listenKey) await callSignedAPI('/fapi/v1/listenKey', 'DELETE', { listenKey }).then(() => addLog("ListenKey đã xóa.")).catch(e => addLog(`Lỗi xóa listenKey: ${e.msg || e.message}`));
    listenKey = null;

    try {
        if (TARGET_COIN_SYMBOL) {
            addLog(`Dọn dẹp vị thế do bot này quản lý cho coin: ${TARGET_COIN_SYMBOL}...`);
            await releaseCoinOnServer(TARGET_COIN_SYMBOL);
            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            await sleep(500);

            if (currentLongPosition) {
                await closePosition(TARGET_COIN_SYMBOL, `Dừng bot (dọn lệnh LONG)`, 'LONG');
                await sleep(500);
            }
            if (currentShortPosition) {
                await closePosition(TARGET_COIN_SYMBOL, `Dừng bot (dọn lệnh SHORT)`, 'SHORT');
                await sleep(500);
            }

            if (sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0) {
                await closeAllSidewaysPositionsAndOrders(`Dừng bot (dọn toàn bộ lưới)`);
            }
            
            addLog(`Hoàn tất dọn dẹp cho ${TARGET_COIN_SYMBOL}.`);
        } else {
            addLog("Không có coin mục tiêu nào đang được bot này quản lý để dọn dẹp.");
        }
    } catch (e) {
        addLog(`Lỗi nghiêm trọng khi dọn dẹp vị thế của bot: ${e.msg || e.message}`);
    }
    
    currentLongPosition = null;
    currentShortPosition = null;
    TARGET_COIN_SYMBOL = null;
    pendingClosures.clear();
    blacklistedCoinsThisSession.clear();
    sidewaysGrid.isActive = false;

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog("Đã hủy retry khởi động.");
    }
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}
async function checkAndHandleRemainingPosition(symbol) {
    if (!symbol) return;
    addLog(`Kiểm tra vị thế sót cho ${symbol}...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const remaining = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        if (remaining.length > 0) {
            addLog(`Tìm thấy ${remaining.length} vị thế sót cho ${symbol}. Đang đóng...`);
            await cancelAllOpenOrdersForSymbol(symbol);
            await sleep(500);
            for (const pos of remaining) {
                await closePosition(pos.symbol, `Dọn dẹp vị thế sót`, pos.positionSide);
                await sleep(1000);
            }
            addLog(`Hoàn tất đóng vị thế sót cho ${symbol}.`);
        } else {
            addLog(`Không có vị thế sót nào cho ${symbol}.`);
        }
    } catch (error) {
        addLog(`Lỗi dọn vị thế sót ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal(`Lỗi dọn vị thế sót ${symbol}`);
    }
}
function scheduleNextMainCycle(delayMs = 7000) {
    if (!botRunning) return;
    if (nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout);
    nextScheduledCycleTimeout = setTimeout(async () => {
        if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForSwitch && !isOpeningInitialPair && pendingClosures.size === 0) {
            try {
                await runTradingLogic();
            } catch (e) {
                addLog(`Lỗi chu kỳ chính runTradingLogic: ${e.msg || e.message} ${e.stack?.substring(0, 300) || ''}`);
                if (e instanceof CriticalApiError) {
                    await stopBotLogicInternal(`CriticalApiError trong chu kỳ chính: ${e.message}`);
                } else if (botRunning) {
                    scheduleNextMainCycle(15000);
                }
            }
        } else if (botRunning) {
            scheduleNextMainCycle(delayMs);
        }
    }, delayMs);
}
async function getListenKey() {
    if (!API_KEY || !SECRET_KEY) {
        addLog("Thiếu API key/secret.");
        return null;
    }
    try {
        const r = await callSignedAPI('/fapi/v1/listenKey', 'POST');
        addLog("Lấy ListenKey thành công.");
        return r.listenKey;
    } catch (e) {
        addLog(`Lỗi lấy listenKey: ${e.msg || e.message}`);
        return null;
    }
}
async function keepAliveListenKey(key) {
    if (!key) return;
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: key });
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
                addLog("Không lấy được listenKey mới. User Stream sẽ không hoạt động.");
                if (botRunning) await stopBotLogicInternal("Không thể gia hạn hoặc lấy listenKey mới.");
            }
        }
    }
}
function setupUserDataStream(key) {
    if (!key) {
        addLog("Không có listenKey cho User Stream.");
        return;
    }
    if (userDataWs && (userDataWs.readyState === WebSocket.OPEN || userDataWs.readyState === WebSocket.CONNECTING)) {
        userDataWs.removeAllListeners();
        userDataWs.terminate();
        userDataWs = null;
    }
    const url = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    userDataWs = new WebSocket(url);
    addLog("Đang kết nối User Data Stream...");
    userDataWs.on('open', () => {
        addLog('User Data Stream đã kết nối.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(() => keepAliveListenKey(listenKey), 30 * 60 * 1000);
    });
    userDataWs.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(msg.o);
            } else if (msg.e === 'ACCOUNT_UPDATE') {
                for (const pos of msg.a.P) {
                     if (pos.s === TARGET_COIN_SYMBOL && parseFloat(pos.pa) === 0) {
                        if (sidewaysGrid.isActive) {
                             const closedGridPos = sidewaysGrid.activeGridPositions.find(p => p.side === pos.ps);
                             if (closedGridPos) {
                                 const oldLength = sidewaysGrid.activeGridPositions.length;
                                 sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== closedGridPos.id);
                                 if (sidewaysGrid.activeGridPositions.length < oldLength) {
                                     addLog(`LƯỚI: Vị thế ${pos.ps} (${closedGridPos.id}) đóng (phát hiện qua ACCOUNT_UPDATE). Xóa khỏi bộ nhớ.`);
                                 }
                             }
                        }
                    }
                }
            } else if (msg.e === 'listenKeyExpired') {
                addLog("User Stream: ListenKey hết hạn.");
                if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
                listenKeyRefreshInterval = null;
                const newKey = await getListenKey();
                if (newKey) {
                    listenKey = newKey;
                    setupUserDataStream(newKey);
                } else {
                    addLog("Không lấy được key mới sau khi hết hạn.");
                    if (botRunning) await stopBotLogicInternal("ListenKey hết hạn và không thể lấy key mới.");
                }
            }
        } catch (e) {
            addLog('Lỗi xử lý User Data Stream: ' + e.message + `. Data: ${data.toString().substring(0, 100)}`);
        }
    });
    userDataWs.on('error', (err) => {
        addLog('Lỗi User Data Stream: ' + err.message);
    });
    userDataWs.on('close', async (code, reason) => {
        addLog(`User Data Stream đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0, 100) : 'N/A'}.`);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
        if (botRunning && listenKey) {
            addLog("  Thử kết nối lại User Stream sau 5s...");
            await sleep(5000);
            if (listenKey) {
                setupUserDataStream(listenKey);
            } else {
                const newKey = await getListenKey();
                if (newKey) {
                    listenKey = newKey;
                    setupUserDataStream(newKey);
                } else {
                    addLog("  Không lấy được listenKey mới.");
                    if (botRunning) await stopBotLogicInternal("User Stream đóng và không thể lấy listenKey mới.");
                }
            }
        }
    });
}
async function updateStatusCache() {
    if (!botRunning) {
        statusCache.fullStatusString = `BOT: DỪNG`;
        statusCache.botStats = {
            success: true,
            data: {
                botRunning: false,
                botStartTime: "N/A",
                currentMode: "N/A",
                vps1Volatility: "N/A",
                totalProfit: totalProfit.toFixed(2),
                totalLoss: totalLoss.toFixed(2),
                netPNL: netPNL.toFixed(2),
                currentCycleOverallPNL: "0.00",
                trueOverallPnlSinceStart: cumulativeRealizedPnlSinceStart.toFixed(2),
                currentCoin: TARGET_COIN_SYMBOL || "N/A",
                initialInvestment: INITIAL_INVESTMENT_AMOUNT,
                overallTakeProfit,
                overallStopLoss,
                killPositions: [],
                sidewaysGridInfo: { isActive: false },
                currentMarketPrice: "N/A",
                pendingPnlChecks: pendingClosures.size
            }
        };
        return;
    }
    
    try {
        const currentCoinV1 = getCurrentCoinVPS1Data(TARGET_COIN_SYMBOL);
        const vps1VolDisplay = currentCoinV1 ? Math.abs(currentCoinV1.changePercent).toFixed(2) + '%' : 'N/A';
        let statusMsg = `BOT: ${botRunning ? 'CHẠY' : 'DỪNG'}`;
        if (botStartTime && botRunning) statusMsg += ` | Up Bot: ${Math.floor((Date.now() - botStartTime.getTime()) / 60000)}p`;
        statusMsg += ` | Coin: ${TARGET_COIN_SYMBOL || "N/A"} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} | Mode: ${currentBotMode.toUpperCase()} (VPS1_Vol:${vps1VolDisplay})`;
        if (isAdjustmentInProgress) statusMsg += " (ĐANG ĐIỀU CHỈNH)";
        if (sidewaysGrid.isClearingForSwitch) statusMsg += " (DỌN LƯỚI/CHUYỂN MODE)";
        
        const cDet = TARGET_COIN_SYMBOL ? await getSymbolDetails(TARGET_COIN_SYMBOL) : null;
        const cPP = cDet ? cDet.pricePrecision : 4;
        
        let posText = "";
        let killPositionsData = [];
        let gridPositionsData = [];
        
        if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
            posText = " | Kill: ";
            for (const p of [currentLongPosition, currentShortPosition]) {
                if (p) {
                    const pnl = p.unrealizedPnl || 0;
                    const totalPnlForPos = pnl + (p.realizedPnlFromPartials || 0);
                    posText += `${p.side[0]}(PNL:${totalPnlForPos.toFixed(1)}) `;
                    const pp = cDet ? cDet.pricePrecision : 2;
                    const qp = cDet ? cDet.quantityPrecision : 3;
                    killPositionsData.push({
                        type: 'kill', side: p.side, entry: p.entryPrice?.toFixed(pp), qty: p.quantity?.toFixed(qp),
                        initialQty: p.initialQuantity?.toFixed(qp), milestone: p.milestoneCounter, closedLossQty: p.closedLossAmount?.toFixed(qp),
                        pnl: pnl.toFixed(2),
                        realizedPnlFromPartials: (p.realizedPnlFromPartials || 0).toFixed(2),
                        totalPnl: totalPnlForPos.toFixed(2),
                        curPrice: p.currentPrice?.toFixed(pp), tpPrice: p.takeProfitPrice?.toFixed(pp), slPrice: p.stopLossPrice?.toFixed(pp)
                    });
                }
            }
        } else if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
            posText = ` | Lưới: ${sidewaysGrid.activeGridPositions.length} lệnh. Anchor: ${sidewaysGrid.anchorPrice?.toFixed(cPP)}. SLs: ${sidewaysGrid.sidewaysStats.slMatchedCount}, TPs: ${sidewaysGrid.sidewaysStats.tpMatchedCount}`;
            const qpG = cDet ? cDet.quantityPrecision : 4;
            for (const p of sidewaysGrid.activeGridPositions) {
                let pnlU = (currentMarketPrice && p.entryPrice) ? (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1) : 0;
                gridPositionsData.push({
                    type: 'grid', id: p.id, side: p.side, entry: p.entryPrice?.toFixed(cPP), qty: p.quantity?.toFixed(qpG),
                    curPrice: currentMarketPrice?.toFixed(cPP), pnl: pnlU.toFixed(2), tpPrice: p.takeProfitPrice?.toFixed(cPP),
                    slPrice: p.stopLossPrice?.toFixed(cPP), step: p.stepIndex
                });
            }
        } else {
            posText = " | Vị thế: --";
        }
        
        statusMsg += posText;
        statusMsg += ` | PNL Ròng (${TARGET_COIN_SYMBOL || 'N/A'}): ${netPNL.toFixed(2)} (L:${totalProfit.toFixed(2)}, T:${totalLoss.toFixed(2)})`;
        
        let trueOverallPnlTemp = cumulativeRealizedPnlSinceStart;
        if (currentLongPosition) {
            trueOverallPnlTemp += (currentLongPosition.unrealizedPnl || 0) + (currentLongPosition.realizedPnlFromPartials || 0);
        }
        if (currentShortPosition) {
            trueOverallPnlTemp += (currentShortPosition.unrealizedPnl || 0) + (currentShortPosition.realizedPnlFromPartials || 0);
        }
        if (sidewaysGrid.isActive && TARGET_COIN_SYMBOL && currentMarketPrice) {
            sidewaysGrid.activeGridPositions.forEach(p => {
                trueOverallPnlTemp += (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1);
            });
        }
        
        statusMsg += ` | PNL BOT Tổng: ${trueOverallPnlTemp.toFixed(2)}`;
        if (pendingClosures.size > 0) statusMsg += ` | Chờ PNL: ${pendingClosures.size}`;
        
        statusCache.fullStatusString = statusMsg;
        
        let currentCycleOverallPNLCalculated = netPNL;
        killPositionsData.forEach(p => { currentCycleOverallPNLCalculated += parseFloat(p.totalPnl) || 0; });
        gridPositionsData.forEach(p => { currentCycleOverallPNLCalculated += parseFloat(p.pnl) || 0; });

        const gridAnchorPrice = sidewaysGrid.anchorPrice || 0;
        const upperBoundary = gridAnchorPrice > 0 ? (gridAnchorPrice * (1 + 10 * 0.015)).toFixed(cPP) : 'N/A';
        const lowerBoundary = gridAnchorPrice > 0 ? (gridAnchorPrice * (1 - 10 * 0.015)).toFixed(cPP) : 'N/A';

        statusCache.botStats = {
            success: true,
            data: {
                botRunning, botStartTime: botStartTime ? formatTimeUTC7(botStartTime) : "N/A", currentMode: currentBotMode.toUpperCase(),
                vps1Volatility: vps1VolDisplay, totalProfit: totalProfit.toFixed(2), totalLoss: totalLoss.toFixed(2),
                netPNL: netPNL.toFixed(2), currentCycleOverallPNL: currentCycleOverallPNLCalculated.toFixed(2),
                trueOverallPnlSinceStart: trueOverallPnlTemp.toFixed(2), currentCoin: TARGET_COIN_SYMBOL || "N/A",
                initialInvestment: INITIAL_INVESTMENT_AMOUNT, overallTakeProfit, overallStopLoss, killPositions: killPositionsData,
                isAdjustmentInProgress,
                sidewaysGridInfo: {
                    isActive: sidewaysGrid.isActive, isClearingForSwitch: sidewaysGrid.isClearingForSwitch,
                    anchorPrice: sidewaysGrid.anchorPrice?.toFixed(cPP),
                    upperBoundary: upperBoundary,
                    lowerBoundary: lowerBoundary,
                    stats: sidewaysGrid.sidewaysStats, activePositions: gridPositionsData
                },
                currentMarketPrice: currentMarketPrice?.toFixed(cPP), pendingPnlChecks: pendingClosures.size
            }
        };

    } catch (e) {
        addLog(`Lỗi khi cập nhật status cache: ${e.message}`);
    }
}
function setupMarketDataStream(symbol) {
    if (!symbol) {
        addLog("Không có symbol cho Market Stream.");
        return;
    }
    if (marketWs && (marketWs.readyState === WebSocket.OPEN || marketWs.readyState === WebSocket.CONNECTING)) {
        const oldS = marketWs.url.split('/').pop().split('@')[0].toUpperCase();
        if (oldS.toLowerCase() === symbol.toLowerCase()) {
            return;
        }
        addLog(`Đóng Market Stream cũ ${oldS}...`);
        marketWs.removeAllListeners();
        marketWs.terminate();
        marketWs = null;
    }
    const streamName = `${symbol.toLowerCase()}@markPrice@1s`;
    const url = `${WS_BASE_URL}/ws/${streamName}`;
    marketWs = new WebSocket(url);
    addLog(`Đang kết nối Market Data Stream cho ${symbol}...`);
    marketWs.on('open', () => addLog(`Market Data Stream ${symbol} đã kết nối.`));
    marketWs.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.e === 'markPriceUpdate' && msg.s === TARGET_COIN_SYMBOL) {
                currentMarketPrice = parseFloat(msg.p);
                if (currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice;
                if (currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice;
            }
        } catch (e) { }
    });
    marketWs.on('error', (err) => {
        addLog(`Lỗi Market Data Stream (${symbol}): ` + err.message);
    });
    marketWs.on('close', (code, reason) => {
        const closedS = marketWs && marketWs.url ? marketWs.url.split('/').pop().split('@')[0].toUpperCase() : symbol;
        addLog(`Market Stream (${closedS}) đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0, 100) : 'N/A'}.`);
        if (botRunning && closedS === TARGET_COIN_SYMBOL) {
            addLog(`Thử kết nối lại Market Stream ${TARGET_COIN_SYMBOL} sau 5s...`);
            setTimeout(() => setupMarketDataStream(TARGET_COIN_SYMBOL), 5000);
        }
    });
}
const app = express();
app.use(express.json());
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send("<h1>Bot Control Panel</h1><p>File index.html không tìm thấy.</p>");
});
app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            addLog(`Lỗi đọc log: ${err.message}`);
            return res.status(500).send('Lỗi đọc log.');
        }
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        res.type('text/plain').send(cleanData.split('\n').slice(-500).join('\n'));
    });
});
app.get('/api/status', async (req, res) => {
    res.type('text/plain').send(statusCache.fullStatusString);
});
app.get('/api/bot_stats', async (req, res) => {
    res.json(statusCache.botStats);
});
app.post('/api/configure', (req, res) => {
    const { initialAmount, overallTakeProfit: newOverallTP, overallStopLoss: newOverallSL } = req.body;
    let changesMade = [];
    let errors = [];

    if (initialAmount !== undefined) {
        const newIA = parseFloat(initialAmount);
        if (!isNaN(newIA) && newIA > 0) {
            if (newIA !== INITIAL_INVESTMENT_AMOUNT) {
                INITIAL_INVESTMENT_AMOUNT = newIA;
                changesMade.push(`Ký quỹ đổi thành ${INITIAL_INVESTMENT_AMOUNT}.`);
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
    let msg;
    if (errors.length > 0) {
        msg = "Lỗi cấu hình: " + errors.join(" ");
        if (changesMade.length > 0) msg += " Thay đổi hợp lệ đã áp dụng: " + changesMade.join(" ");
        addLog(`Cấu hình API thất bại: ${msg}`);
        res.status(400).json({ success: false, message: msg });
    } else if (changesMade.length > 0) {
        msg = "Cấu hình cập nhật: " + changesMade.join(" ");
        addLog(msg);
        res.json({ success: true, message: msg });
    } else {
        msg = "Không có thay đổi cấu hình.";
        res.json({ success: true, message: msg });
    }
});
app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', async (req, res) => res.send(await stopBotLogicInternal("Lệnh dừng từ API /stop_bot_logic")));
;(async () => {
    try {
        if (!API_KEY || !SECRET_KEY || API_KEY === 'YOUR_BINANCE_API_KEY') addLog("LỖI NGHIÊM TRỌNG: API_KEY/SECRET_KEY chưa cấu hình!");
        await syncServerTime();
        await getExchangeInfo();
        await fetchAndCacheTopCoinsFromVPS1();
        const server = app.listen(WEB_SERVER_PORT, '0.0.0.0', () => {
            addLog(`Web server Bot Client (HTTP) chạy tại http://<YOUR_IP>:${WEB_SERVER_PORT}`);
            addLog(`Log file: ${CUSTOM_LOG_FILE}`);
        });
        server.on('error', (e) => {
            addLog(`Lỗi khởi động server: ${e.message}`);
            process.exit(1);
        });
    } catch (e) {
        addLog(`LỖI KHỞI TẠO SERVER/BINANCE API: ${e.msg || e.message}. Bot có thể không hoạt động.`);
        try {
            const srv = app.listen(WEB_SERVER_PORT, '0.0.0.0', () => addLog(`Web server (CHẾ ĐỘ LỖI - HTTP) chạy tại http://<YOUR_IP>:${WEB_SERVER_PORT}`));
            srv.on('error', (ef) => {
                addLog(`Lỗi khởi động server (fallback): ${ef.message}`);
                process.exit(1);
            });
        } catch (efinal) {
            addLog(`Không thể khởi động server: ${efinal.message}`);
            process.exit(1);
        }
    }
})();
process.on('unhandledRejection', async (reason, promise) => {
    const reasonMsg = reason?.stack || reason?.message || reason?.toString() || "Unknown unhandled rejection";
    addLog(`Unhandled Rejection: ${reasonMsg}`);
    if (botRunning) {
        await stopBotLogicInternal(`Unhandled Rejection: ${reasonMsg.substring(0, 100)}`);
    }
});
process.on('uncaughtException', async (error) => {
    const errorMsg = error.stack || error.message || error.toString() || "Unknown uncaught exception";
    addLog(`Uncaught Exception: ${errorMsg}`);
    if (botRunning) {
        await stopBotLogicInternal(`Uncaught Exception: ${errorMsg.substring(0, 100)}`);
    }
    process.exit(1);
});
