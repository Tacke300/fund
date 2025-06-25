
import http from 'http';
import https from 'https';
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
const VPS_SPECIFIC_DELAY_MS = parseInt(process.env.VPS_DELAY) || Math.floor(Math.random() * 8000) + 2000;
const MIN_CANDLES_FOR_SELECTION = 55;
const VOLATILITY_SWITCH_THRESHOLD_PERCENT = 5.0;
const COIN_SWITCH_CHECK_INTERVAL_MS = 30 * 1000;

const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

const WEB_SERVER_PORT = parseInt(process.env.WEB_PORT) || 1277;
const THIS_BOT_PM2_NAME = process.env.PM2_APP_NAME || path.basename(__filename, '.js');
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
    const offset = 7 * 60 * 60 * 1000;
    const localTime = new Date(now.getTime() + offset);
    const time = `${localTime.toLocaleDateString('en-GB')} ${localTime.toLocaleTimeString('en-US', { hour12: false })}.${String(localTime.getMilliseconds()).padStart(3, '0')}`;
    
    let logEntry = `[${time}] ${message}`;
    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        if ((localTime.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return;
        } else {
            if (logCounts[messageHash].count > 1) {
                const logText = `[${time}] (Lặp lại x${logCounts[messageHash].count -1} lần trước đó) ${message}`;
                console.log(logText);
                if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logText + '\n', (err) => { if (err) console.error("Lỗi ghi log:", err);});
            } else {
                console.log(logEntry);
                if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {if (err) console.error("Lỗi ghi log:", err);});
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: localTime };
        }
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {if (err) console.error("Lỗi ghi log:", err);});
        logCounts[messageHash] = { count: 1, lastLoggedTime: localTime };
    }
}

function formatTimeUTC7(dateObject) {
    if (!dateObject) return 'N/A';
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        fractionalSecondDigits: 3, hour12: false, timeZone: 'Asia/Ho_Chi_Minh'
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
            headers: {...headers, 'User-Agent': 'NodeJS-Client/1.0-VPS2'},
            timeout: 10000
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
                    let errorDetails = { code: res.statusCode, msg: errorMsg, url: urlString, responseBody: data.substring(0, 500) };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {  }
                    reject(errorDetails);
                }
            });
        });
        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: `${e.message} (khi gọi ${urlString})`, url: urlString }));
        req.on('timeout', () => {
            req.destroy();
            reject({ code: 'TIMEOUT_ERROR', msg: `Request timed out sau ${options.timeout/1000}s (khi gọi ${urlString})`, url: urlString });
        });
        if (postData && (method === 'POST' || method === 'PUT')) {
             req.write(postData);
        }
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) throw new CriticalApiError("Lỗi: Thiếu API_KEY hoặc SECRET_KEY trong config.js.");
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
    } else { throw new Error(`Phương thức API không hỗ trợ: ${method}`); }

    const fullUrlToCall = `https://${BASE_HOST}${requestPath}`;

    try {
        const rawData = await makeHttpRequest(method, fullUrlToCall, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi API Binance (${method} ${fullUrlToCall}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}. Body (nếu có): ${error.responseBody || 'N/A'}`);
        if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); }
        if (error.code === -1021 && error.msg && error.msg.toLowerCase().includes("timestamp for this request is outside of the recvwindow")) {
            addLog("  -> Lỗi Timestamp, đang đồng bộ lại thời gian server...");
            await syncServerTime();
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Quá nhiều lỗi API Binance liên tiếp, bot dừng.");
        }
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
        addLog(`Lỗi API công khai Binance (${fullUrlToCall}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}. Body (nếu có): ${error.responseBody || 'N/A'}`);
        if (error.code === -1003 || (error.msg && error.msg.includes("limit"))) { addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT)."); }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Quá nhiều lỗi API Binance liên tiếp, bot dừng.");
        }
        throw error;
    }
}

async function fetchTopCoinsFromVPS1() {
    const fullUrl = VPS1_DATA_URL;
    addLog(`Đang lấy dữ liệu top coin từ VPS1: ${fullUrl}`);
    try {
        const rawData = await makeHttpRequest('GET', fullUrl, {});
        const response = JSON.parse(rawData);

        if (response && response.status === "success" && Array.isArray(response.data)) {
            addLog(`VPS1 data received (status: success). Found ${response.data.length} coins. Filtering by min candles (${MIN_CANDLES_FOR_SELECTION})...`);
            const filteredCoins = response.data.filter(c => c.symbol && typeof c.changePercent === 'number' && c.candles >= MIN_CANDLES_FOR_SELECTION);
            if (filteredCoins.length === 0 && response.data.length > 0) {
                addLog(`  -> VPS1 returned ${response.data.length} coins, but 0 met MIN_CANDLES_FOR_SELECTION (${MIN_CANDLES_FOR_SELECTION}). Check VPS1 logs/config.`);
            } else if (response.data.length === 0) {
                 addLog(`  -> VPS1 returned 0 coins in 'data' field.`);
            }
            return filteredCoins;
        } else if (response && response.status === "initializing") {
            addLog(`VPS1 is still initializing: ${response.message || 'No specific message'}. No coins to process yet.`);
            return [];
        } else if (response && response.status === "error_binance_symbols") {
            addLog(`VPS1 reported symbol fetching error: ${response.message || 'Error fetching symbols from Binance on VPS1.'}. No coins available.`);
            return [];
        } else if (response && response.status && response.status.startsWith("error")) {
            addLog(`Error reported by VPS1 (status: ${response.status}): ${response.message || 'No specific message'}. No coins to process.`);
            return [];
        } else {
            addLog(`Lỗi: Dữ liệu từ VPS1 có định dạng không mong muốn. Status: ${response?.status}, Message: ${response?.message}. Raw (first 300 chars): ${rawData.substring(0, 300)}`);
            return [];
        }
    } catch (error) {
        addLog(`Lỗi khi lấy hoặc phân tích dữ liệu từ VPS1 (${fullUrl}): ${error.code || 'UNKNOWN_PARSE_ERROR'} - ${error.msg || error.message}. Body (nếu có): ${error.responseBody || 'N/A'}`);
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
             addLog(`Symbol ${symbol} không hợp lệ trên Binance khi kiểm tra vị thế. Coi như không có vị thế.`);
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
        addLog("Không có coin nào từ VPS1 hoặc có lỗi / chưa đủ nến. Không thể chọn coin.");
        return null;
    }

    addLog(`Đã nhận ${topCoins.length} coin tiềm năng từ VPS1 (đã lọc theo MIN_CANDLES_FOR_SELECTION). Bắt đầu kiểm tra vị thế...`);
    for (let i = 0; i < topCoins.length; i++) {
        const coin = topCoins[i];
        addLog(`Kiểm tra coin #${i + 1}: ${coin.symbol} (Biến động VPS1: ${coin.changePercent}%, Nến VPS1: ${coin.candles})`);
        const hasPosition = await checkExistingPosition(coin.symbol);
        await sleep(300);
        if (!hasPosition) {
            addLog(`Đã chọn ${coin.symbol} (Biến động VPS1: ${coin.changePercent}%) làm coin mục tiêu. Chưa có vị thế.`);
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
            let minLow = parseFloat(klines[0][3]);
            let maxHigh = parseFloat(klines[0][2]);
            for (let i = 1; i < klines.length; i++) {
                const low = parseFloat(klines[i][3]);
                const high = parseFloat(klines[i][2]);
                if (low < minLow) minLow = low;
                if (high > maxHigh) maxHigh = high;
            }
            if (minLow > 0) {
                const volatility = ((maxHigh - minLow) / minLow) * 100;
                lastCalculatedVolatility = volatility;
                return volatility;
            }
        }
        addLog(`Không đủ dữ liệu klines (nhận ${klines?.length}/60) cho ${symbol} để tính biến động. Dùng giá trị cũ: ${lastCalculatedVolatility.toFixed(2)}%`);
        return lastCalculatedVolatility;
    } catch (e) {
        addLog(`Lỗi tính biến động 1 giờ qua cho ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) throw e;
        return lastCalculatedVolatility;
    }
}

async function syncServerTime() {
    try {
        const d = await callPublicAPI('/fapi/v1/time');
        serverTimeOffset = d.serverTime - Date.now();
        addLog(`Đồng bộ thời gian server Binance thành công. Offset: ${serverTimeOffset}ms`);
    } catch (e) {
        addLog(`Lỗi đồng bộ thời gian server: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) { await stopBotLogicInternal(); throw e; }
    }
}

async function getLeverageBracketForSymbol(symbol) {
    if(!symbol) return null;
    try {
        const r = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        const b = r.find(i => i.symbol === symbol)?.brackets[0];
        return b ? parseInt(b.initialLeverage) : null;
    } catch (e) {
        addLog(`Lỗi lấy leverage bracket cho ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) await stopBotLogicInternal();
        return null;
    }
}

async function setLeverage(symbol, leverage) {
    if(!symbol) return false;
    try {
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol} thành công.`);
        return true;
    } catch (e) {
        addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) await stopBotLogicInternal();
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
                tickSize: parseFloat(pF?.tickSize || 0.00000001),
                stepSize: parseFloat(lF?.stepSize || 0.00000001),
                minNotional: parseFloat(mF?.notional || 0.1)
            };
        });
        addLog("Lấy Exchange Info thành công và đã cache.");
        return exchangeInfoCache;
    } catch (e) {
        addLog(`Lỗi lấy Exchange Info: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) await stopBotLogicInternal();
        throw e;
    }
}

async function getSymbolDetails(symbol) {
    if(!symbol) return null;
    const info = await getExchangeInfo();
    if (!info) {
        addLog(`Không thể lấy Exchange Info để lấy chi tiết cho ${symbol}.`);
        return null;
    }
    const details = info[symbol];
    if (!details) {
        addLog(`Không tìm thấy chi tiết cho symbol ${symbol} trong Exchange Info. Symbol có thể đã bị delist. Thử làm mới cache...`);
        exchangeInfoCache = null;
        const freshInfo = await getExchangeInfo();
        const freshDetails = freshInfo?.[symbol] || null;
        if(freshDetails) addLog(`  Đã tìm thấy ${symbol} sau khi làm mới cache.`); else addLog(`  Vẫn không tìm thấy ${symbol} sau khi làm mới cache.`);
        return freshDetails;
    }
    return details;
}

async function getCurrentPrice(symbol) {
    if(!symbol) return null;
    try {
        const d = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(d.price);
    } catch (e) {
        addLog(`Lỗi lấy giá hiện tại cho ${symbol}: ${e.msg || e.message}`);
        if (e instanceof CriticalApiError) await stopBotLogicInternal();
        return null;
    }
}

async function cancelAllOpenOrdersForSymbol(symbol) {
    if (!symbol) return;
    addLog(`Hủy TẤT CẢ lệnh chờ cho ${symbol}...`);
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol });
        if (!openOrders || openOrders.length === 0) {
            addLog(`Không có lệnh chờ nào cho ${symbol} để hủy.`);
            return;
        }
        addLog(`Tìm thấy ${openOrders.length} lệnh chờ cho ${symbol}. Đang hủy...`);
        for (const order of openOrders) {
            try {
                await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: symbol, orderId: order.orderId, origClientOrderId: order.clientOrderId });
                addLog(`  Đã hủy lệnh ${order.orderId} (Client ID: ${order.clientOrderId}) cho ${symbol}.`);
                await sleep(100);
            }
            catch (innerErr) {
                if (innerErr.code !== -2011) {
                    addLog(`  Lỗi hủy lệnh ${order.orderId} cho ${symbol}: ${innerErr.msg || innerErr.message}`);
                } else {
                    addLog(`  Lệnh ${order.orderId} cho ${symbol} có thể đã được xử lý (khớp/hủy).`);
                }
                if (innerErr instanceof CriticalApiError) await stopBotLogicInternal();
            }
        }
        addLog(`Hoàn tất hủy lệnh chờ cho ${symbol}.`);
    } catch (error) {
        if (error.code !== -2011) {
            addLog(`Lỗi lấy danh sách lệnh chờ để hủy cho ${symbol}: ${error.msg || error.message}`);
        }
        if (error instanceof CriticalApiError) await stopBotLogicInternal();
    }
}

async function closePosition(symbol, reason, positionSideToClose) {
    if (symbol !== TARGET_COIN_SYMBOL || !positionSideToClose || isProcessingTrade) {
        if(isProcessingTrade) addLog(`closePosition bị bỏ qua cho ${symbol} do isProcessingTrade=true`);
        return false;
    }
    isProcessingTrade = true;
    addLog(`Đóng lệnh ${positionSideToClose} ${symbol} (Lý do: ${reason})...`);
    let errOccurred = null;
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol });
        const posOnEx = positions.find(p => p.symbol === symbol && p.positionSide === positionSideToClose && parseFloat(p.positionAmt) !== 0);
        if (posOnEx) {
            const qty = Math.abs(parseFloat(posOnEx.positionAmt));
            if (qty === 0) {
                addLog(`Không có khối lượng thực tế cho ${positionSideToClose} ${symbol} để đóng.`);
                isProcessingTrade = false; return false;
            }
            const sideOrder = (positionSideToClose === 'LONG') ? 'SELL' : 'BUY';
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol,
                side: sideOrder,
                positionSide: positionSideToClose,
                type: 'MARKET',
                quantity: qty,
                newClientOrderId: `CLOSE-${positionSideToClose.substring(0,1)}-${Date.now()}`
            });
            addLog(`Đã gửi lệnh MARKET đóng ${qty} ${positionSideToClose} ${symbol}.`);
            if (positionSideToClose === 'LONG' && currentLongPosition) currentLongPosition.quantity = 0;
            else if (positionSideToClose === 'SHORT' && currentShortPosition) currentShortPosition.quantity = 0;
            isProcessingTrade = false; return true;
        } else {
            addLog(`Không tìm thấy vị thế ${positionSideToClose} cho ${symbol} trên sàn để đóng.`);
            isProcessingTrade = false; return false;
        }
    } catch (err) {
        errOccurred = err;
        addLog(`Lỗi đóng vị thế ${positionSideToClose} cho ${symbol}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError) await stopBotLogicInternal();
        isProcessingTrade = false; return false;
    } finally {
        if (isProcessingTrade && !(errOccurred instanceof CriticalApiError)) {
            isProcessingTrade = false;
        }
    }
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
        if (qty * priceCalc < details.minNotional) {
            addLog(`Giá trị lệnh ${qty} * ${priceCalc} = ${qty*priceCalc} USDT quá nhỏ cho ${symbol} (yêu cầu min: ${details.minNotional} USDT). Tăng vốn hoặc kiểm tra lại logic.`);
            throw new Error(`Giá trị lệnh quá nhỏ cho ${symbol}.`);
        }
        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const orderRes = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSide, positionSide: tradeDirection, type: 'MARKET', quantity: qty, newOrderRespType: 'RESULT' });
        const actualEntry = parseFloat(orderRes.avgPrice); const actualQty = parseFloat(orderRes.executedQty);
        if (actualQty === 0) throw new Error(`Lệnh MARKET cho ${symbol} không khớp KL.`);
        addLog(`[KILL] Đã MỞ ${tradeDirection} ${symbol} | KL: ${actualQty.toFixed(details.quantityPrecision)} | Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);
        return { symbol, quantity: actualQty, initialQuantity: actualQty, entryPrice: actualEntry, initialMargin: INITIAL_INVESTMENT_AMOUNT, side: tradeDirection, maxLeverageUsed: maxLeverage, pricePrecision: details.pricePrecision, quantityPrecision: details.quantityPrecision, closedLossAmount: 0, nextPartialCloseLossIndex: 0, pnlBaseForNextMoc: 0, hasAdjustedSLToSpecificLevel: {}, hasClosedAllLossPositionAtLastLevel: false, pairEntryPrice: priceCalc, currentTPId: null, currentSLId: null, unrealizedPnl: 0, currentPrice: actualEntry };
    } catch (err) { addLog(`[KILL] Lỗi mở ${tradeDirection} ${symbol}: ${err.msg || err.message}`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); return null; }
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
        const priceChangeSL = targetPnlSL_USD / initialQuantity;

        let tpPx = parseFloat((entryPrice + priceChangeTP).toFixed(pricePrecision));
        let slPx = parseFloat((entryPrice + priceChangeSL).toFixed(pricePrecision));

        if (side === 'LONG') {
            if (tpPx <= entryPrice + details.tickSize) tpPx = parseFloat((entryPrice + details.tickSize * 2).toFixed(pricePrecision));
            if (slPx >= entryPrice - details.tickSize) slPx = parseFloat((entryPrice - details.tickSize * 2).toFixed(pricePrecision));
            if (slPx >= tpPx && tpPx > entryPrice) slPx = parseFloat((tpPx - details.tickSize).toFixed(pricePrecision));
        } else {
            if (tpPx >= entryPrice - details.tickSize) tpPx = parseFloat((entryPrice - details.tickSize * 2).toFixed(pricePrecision));
            if (slPx <= entryPrice + details.tickSize) slPx = parseFloat((entryPrice + details.tickSize * 2).toFixed(pricePrecision));
            if (slPx <= tpPx && tpPx < entryPrice) slPx = parseFloat((tpPx + details.tickSize).toFixed(pricePrecision));
        }

        const orderSideClose = (side === 'LONG') ? 'SELL' : 'BUY';
        if (quantity <= 0) { addLog(`[KILL] KL cho ${side} ${symbol} là 0, không đặt TP/SL.`); return false; }

        addLog(`  ${side} ${symbol}: TP dự kiến ${tpPx.toFixed(pricePrecision)}, SL dự kiến ${slPx.toFixed(pricePrecision)} cho KL ${quantity}`);

        if(position.currentTPId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentTPId}); position.currentTPId=null;} catch(e){ if(e.code !== -2011) addLog(`  Cảnh báo: Lỗi hủy TP cũ ${position.currentTPId}: ${e.msg}`);}
        if(position.currentSLId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentSLId}); position.currentSLId=null;} catch(e){ if(e.code !== -2011) addLog(`  Cảnh báo: Lỗi hủy SL cũ ${position.currentSLId}: ${e.msg}`);}
        await sleep(300);

        const slOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSideClose, positionSide: side, type: 'STOP_MARKET', stopPrice: slPx, quantity, timeInForce: 'GTC', closePosition: 'true', newClientOrderId: `KILL-SL-${side.substring(0,1)}${Date.now()}` });
        const tpOrd = await callSignedAPI('/fapi/v1/order', 'POST', { symbol, side: orderSideClose, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPx, quantity, timeInForce: 'GTC', closePosition: 'true', newClientOrderId: `KILL-TP-${side.substring(0,1)}${Date.now()}` });

        position.currentTPId = tpOrd.orderId;
        position.currentSLId = slOrd.orderId;
        addLog(`  Đã đặt TP ID: ${tpOrd.orderId}, SL ID: ${slOrd.orderId} cho ${side} ${symbol}.`);

        if (!position.partialCloseLossLevels || position.partialCloseLossLevels.length === 0 || isFullResetEvent) {
            position.partialCloseLossLevels = steps;
        }
        if (isFullResetEvent) {
            position.nextPartialCloseLossIndex = 0;
            position.hasAdjustedSLToSpecificLevel = {};
            position.hasClosedAllLossPositionAtLastLevel = false;
        }
        if (typeof position.pnlBaseForNextMoc !== 'number') position.pnlBaseForNextMoc = 0;
        return true;
    } catch (err) { addLog(`[KILL] Lỗi đặt TP/SL ${side} ${symbol}: ${err.msg || err.message}.`); if (err instanceof CriticalApiError) await stopBotLogicInternal(); return false; }
}

async function closePartialPosition(position, quantityToClose) {
    if (!position || position.quantity <= 0 || isProcessingTrade || quantityToClose <=0 || !position.symbol) return false;
    isProcessingTrade = true;
    let errOccurred = null;
    try {
        const details = await getSymbolDetails(position.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol ${position.symbol}.`);
        let qtyEff = Math.min(quantityToClose, position.quantity);
        qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));

        if (qtyEff <= 0 || qtyEff * (position.currentPrice || position.entryPrice) < details.minNotional * 0.9) {
            addLog(`[KILL] KL đóng từng phần ${qtyEff.toFixed(details.quantityPrecision)} cho ${position.side} ${position.symbol} quá nhỏ hoặc không hợp lệ. Bỏ qua.`);
            isProcessingTrade = false;
            return false;
        }

        const sideOrder = (position.side === 'LONG') ? 'SELL' : 'BUY';
        addLog(`[KILL] Đóng từng phần ${qtyEff.toFixed(details.quantityPrecision)} ${position.side} ${position.symbol}.`);
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: sideOrder,
            positionSide: position.side,
            type: 'MARKET',
            quantity: qtyEff,
            newClientOrderId: `KILL-PARTIAL-${position.side.substring(0,1)}${Date.now()}`
        });

        position.closedLossAmount += qtyEff;
        position.quantity -= qtyEff;

        if (position.quantity < details.stepSize) position.quantity = 0;

        addLog(`  Đã gửi lệnh đóng. ${position.side} ${position.symbol} còn lại dự kiến: ${position.quantity.toFixed(details.quantityPrecision)}`);

        if (position.quantity > 0) {
            if(position.currentTPId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentTPId}); position.currentTPId=null;} catch(e){if(e.code !== -2011)addLog(`  Cảnh báo: Lỗi hủy TP cũ ${position.currentTPId} sau partial close: ${e.msg}`);}
            if(position.currentSLId) try {await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol: position.symbol, orderId: position.currentSLId}); position.currentSLId=null;} catch(e){if(e.code !== -2011)addLog(`  Cảnh báo: Lỗi hủy SL cũ ${position.currentSLId} sau partial close: ${e.msg}`);}
            await sleep(500);
            await setTPAndSLForPosition(position, false);
        } else {
            addLog(`  ${position.side} ${position.symbol} đã đóng hết sau partial close.`);
            if (position.side === 'LONG') currentLongPosition = null;
            else currentShortPosition = null;
        }
        isProcessingTrade = false; return true;
    } catch (err) {
        errOccurred = err;
        addLog(`[KILL] Lỗi đóng từng phần ${position.side} ${position.symbol}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError) await stopBotLogicInternal();
        isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(errOccurred instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function addPosition(positionToModify, quantityToAdd, reasonForAdd = "generic_reopen") {
    if (!positionToModify || quantityToAdd <= 0 || isProcessingTrade || !positionToModify.symbol) return false;
    isProcessingTrade = true;
    let errOccurred = null;
    try {
        const details = await getSymbolDetails(positionToModify.symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol ${positionToModify.symbol}.`);

        let qtyEff = quantityToAdd;
        if (reasonForAdd !== "kill_mode_reopen_closed_losing_pos") {
            const currentQtyOnBot = positionToModify.quantity;
            const maxAddable = positionToModify.initialQuantity - currentQtyOnBot;
            if (maxAddable <= 0 && reasonForAdd !== "kill_to_sideways_reopen_losing") {
                addLog(`[KILL ADD] ${positionToModify.side} ${positionToModify.symbol} đã đủ KL ban đầu. Không thêm.`);
                isProcessingTrade = false; return false;
            }
            qtyEff = Math.min(qtyEff, maxAddable);
        }

        qtyEff = parseFloat((Math.floor(qtyEff / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));

        if (qtyEff <= 0 || qtyEff * (positionToModify.currentPrice || positionToModify.entryPrice) < details.minNotional * 0.9) {
            addLog(`[KILL ADD] KL thêm ${qtyEff.toFixed(details.quantityPrecision)} cho ${positionToModify.side} ${positionToModify.symbol} quá nhỏ hoặc không hợp lệ. Bỏ qua.`);
            isProcessingTrade = false; return false;
        }

        const sideOrder = (positionToModify.side === 'LONG') ? 'BUY' : 'SELL';
        addLog(`[KILL ADD] Mở thêm ${qtyEff.toFixed(details.quantityPrecision)} ${positionToModify.symbol} cho ${positionToModify.side} (Lý do: ${reasonForAdd}).`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: positionToModify.symbol,
            side: sideOrder,
            positionSide: positionToModify.side,
            type: 'MARKET',
            quantity: qtyEff,
            newClientOrderId: `KILL-ADD-${positionToModify.side.substring(0,1)}${Date.now()}`
        });

        positionToModify.closedLossAmount -= qtyEff;
        if (positionToModify.closedLossAmount < 0) positionToModify.closedLossAmount = 0;

        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
        await sleep(500);

        const otherP = (positionToModify.side === 'LONG') ? currentShortPosition : currentLongPosition;
        if (reasonForAdd === "sideways_moc5_reopen" && otherP && otherP.initialMargin > 0) { 
            otherP.pnlBaseForNextMoc = (otherP.unrealizedPnl / otherP.initialMargin) * 100;
            otherP.nextPartialCloseLossIndex = 0;
            otherP.hasAdjustedSLToSpecificLevel = {};
        } else if (reasonForAdd === "price_near_pair_entry_reopen") {
            positionToModify.pnlBaseForNextMoc = 0;
            positionToModify.nextPartialCloseLossIndex = 0;
        } else if (reasonForAdd === "kill_mode_reopen_closed_losing_pos") {
            positionToModify.pnlBaseForNextMoc = 0;
            positionToModify.nextPartialCloseLossIndex = 0;
            if (otherP && otherP.initialMargin > 0) {
                otherP.pnlBaseForNextMoc = (otherP.unrealizedPnl / otherP.initialMargin) * 100;
                otherP.nextPartialCloseLossIndex = 0;
                otherP.hasAdjustedSLToSpecificLevel = {};
            }
        }

        const newPairEntry = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (newPairEntry) {
            if (currentLongPosition) currentLongPosition.pairEntryPrice = newPairEntry;
            if (currentShortPosition) currentShortPosition.pairEntryPrice = newPairEntry;
            addLog(`  Cập nhật giá vào cặp mới cho ${TARGET_COIN_SYMBOL}: ${newPairEntry.toFixed(details.pricePrecision)}`);
        }

        await sleep(2000);

        const updatedPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
        if (currentLongPosition) {
            const lpEx = updatedPositions.find(p => p.symbol === currentLongPosition.symbol && p.positionSide === 'LONG');
            if (lpEx && parseFloat(lpEx.positionAmt) !== 0) {
                currentLongPosition.quantity = Math.abs(parseFloat(lpEx.positionAmt));
                currentLongPosition.entryPrice = parseFloat(lpEx.entryPrice);
                addLog(`  Cập nhật Long ${TARGET_COIN_SYMBOL}: KL ${currentLongPosition.quantity.toFixed(details.quantityPrecision)}, Giá vào TB ${currentLongPosition.entryPrice.toFixed(details.pricePrecision)}`);
            } else if (lpEx && parseFloat(lpEx.positionAmt) === 0) {
                 currentLongPosition = null;
                 addLog(`  Cảnh báo: Vị thế Long ${TARGET_COIN_SYMBOL} có KL = 0 sau khi thêm. Đã xóa khỏi bot.`);
            } else if (!lpEx) { 
                 currentLongPosition = null;
                 addLog(`  Cảnh báo: Không tìm thấy vị thế Long ${TARGET_COIN_SYMBOL} sau khi thêm. Đã xóa khỏi bot.`);
            }
        }
        if (currentShortPosition) {
            const spEx = updatedPositions.find(p => p.symbol === currentShortPosition.symbol && p.positionSide === 'SHORT');
            if (spEx && parseFloat(spEx.positionAmt) !== 0) {
                currentShortPosition.quantity = Math.abs(parseFloat(spEx.positionAmt));
                currentShortPosition.entryPrice = parseFloat(spEx.entryPrice);
                addLog(`  Cập nhật Short ${TARGET_COIN_SYMBOL}: KL ${currentShortPosition.quantity.toFixed(details.quantityPrecision)}, Giá vào TB ${currentShortPosition.entryPrice.toFixed(details.pricePrecision)}`);
            } else if (spEx && parseFloat(spEx.positionAmt) === 0) {
                 currentShortPosition = null;
                 addLog(`  Cảnh báo: Vị thế Short ${TARGET_COIN_SYMBOL} có KL = 0 sau khi thêm. Đã xóa khỏi bot.`);
            } else if (!spEx) {
                 currentShortPosition = null;
                 addLog(`  Cảnh báo: Không tìm thấy vị thế Short ${TARGET_COIN_SYMBOL} sau khi thêm. Đã xóa khỏi bot.`);
            }
        }

        let tpslOk = true;
        if (currentLongPosition?.quantity > 0) {
            if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslOk = false;
            await sleep(300);
        }
        if (currentShortPosition?.quantity > 0) {
            if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslOk = false;
        }
        if (!tpslOk) addLog(`[KILL ADD] Lỗi đặt lại TP/SL sau khi thêm vị thế cho ${TARGET_COIN_SYMBOL}.`);

        isProcessingTrade = false; return true;
    } catch (err) {
        errOccurred = err;
        addLog(`[KILL ADD] Lỗi mở lại lệnh ${positionToModify.side} ${positionToModify.symbol}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError) await stopBotLogicInternal();
        isProcessingTrade = false; return false;
    } finally { if(isProcessingTrade && !(errOccurred instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function openGridPositionAndSetTPSL(symbol, tradeDirection, entryPriceToTarget, stepIndex) {
    if(!symbol) return null;
    addLog(`[LƯỚI] Mở lệnh ${tradeDirection} ${symbol} bước ${stepIndex}, giá mục tiêu ~${entryPriceToTarget.toFixed(4)}`);
    isProcessingTrade = true;
    let errOccurred = null;
    try {
        const details = await getSymbolDetails(symbol); if (!details) throw new Error(`Lỗi lấy chi tiết symbol ${symbol} cho lệnh lưới.`);
        const maxLev = await getLeverageBracketForSymbol(symbol); if (!maxLev) throw new Error(`Không lấy được đòn bẩy cho lệnh lưới ${symbol}.`);
        if (!await setLeverage(symbol, maxLev)) throw new Error(`Lỗi đặt đòn bẩy cho ${symbol}.`); await sleep(200);

        let qty = (INITIAL_INVESTMENT_AMOUNT * SIDEWAYS_ORDER_SIZE_RATIO * maxLev) / entryPriceToTarget;
        qty = parseFloat((Math.floor(qty / details.stepSize) * details.stepSize).toFixed(details.quantityPrecision));

        if (qty * entryPriceToTarget < details.minNotional) {
            addLog(`[LƯỚI] Giá trị lệnh lưới ${qty} * ${entryPriceToTarget} = ${qty*entryPriceToTarget} USDT quá nhỏ cho ${symbol} (yêu cầu min: ${details.minNotional} USDT).`);
            isProcessingTrade = false;
            throw new Error(`Giá trị lệnh lưới quá nhỏ cho ${symbol}.`);
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';
        const marketOrderRes = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol,
            side: orderSide,
            positionSide: tradeDirection,
            type: 'MARKET',
            quantity: qty,
            newOrderRespType: 'RESULT',
            newClientOrderId: `GRID-M-${tradeDirection[0]}${stepIndex}-${Date.now()}`
        });

        const actualEntry = parseFloat(marketOrderRes.avgPrice);
        const actualQty = parseFloat(marketOrderRes.executedQty);
        if (actualQty === 0) throw new Error(`Lệnh lưới MARKET cho ${symbol} không khớp KL.`);

        addLog(`[LƯỚI] Đã MỞ ${tradeDirection} ${symbol} KL: ${actualQty.toFixed(details.quantityPrecision)}, Giá vào: ${actualEntry.toFixed(details.pricePrecision)}`);

        const gridPos = {
            id: marketOrderRes.orderId,
            symbol,
            side: tradeDirection,
            entryPrice: actualEntry,
            quantity: actualQty,
            tpOrderId: null,
            slOrderId: null,
            originalAnchorPrice: sidewaysGrid.anchorPrice,
            stepIndex,
            pricePrecision: details.pricePrecision, 
            quantityPrecision: details.quantityPrecision
        };

        let tpVal = actualEntry * (1 + (tradeDirection === 'LONG' ? SIDEWAYS_TP_PERCENT_FROM_ENTRY : -SIDEWAYS_TP_PERCENT_FROM_ENTRY));
        let slVal = actualEntry * (1 - (tradeDirection === 'LONG' ? SIDEWAYS_SL_PERCENT_FROM_ENTRY : -SIDEWAYS_SL_PERCENT_FROM_ENTRY));
        tpVal = parseFloat(tpVal.toFixed(details.pricePrecision));
        slVal = parseFloat(slVal.toFixed(details.pricePrecision));

        const tpslSideClose = (tradeDirection === 'LONG') ? 'SELL' : 'BUY';

        try {
            const tpOrd = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: tpslSideClose, positionSide: tradeDirection, type: 'TAKE_PROFIT_MARKET',
                stopPrice: tpVal, quantity: actualQty, timeInForce: 'GTC', closePosition: 'true',
                newClientOrderId: `GRID-TP-${tradeDirection[0]}${stepIndex}-${gridPos.id}-${Date.now()}`
            });
            gridPos.tpOrderId = tpOrd.orderId;
            addLog(`  [LƯỚI] Đặt TP cho ${tradeDirection} ${symbol} @ ${tpVal.toFixed(details.pricePrecision)} (ID: ${tpOrd.orderId})`);
        } catch (e) {
            addLog(`  [LƯỚI] LỖI đặt TP ${tradeDirection} ${symbol} @${actualEntry.toFixed(4)}: ${e.msg || e.message}`);
        }

        try {
            const slOrd = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol, side: tpslSideClose, positionSide: tradeDirection, type: 'STOP_MARKET',
                stopPrice: slVal, quantity: actualQty, timeInForce: 'GTC', closePosition: 'true',
                newClientOrderId: `GRID-SL-${tradeDirection[0]}${stepIndex}-${gridPos.id}-${Date.now()}`
            });
            gridPos.slOrderId = slOrd.orderId;
            addLog(`  [LƯỚI] Đặt SL cho ${tradeDirection} ${symbol} @ ${slVal.toFixed(details.pricePrecision)} (ID: ${slOrd.orderId})`);
        } catch (e) {
            addLog(`  [LƯỚI] LỖI đặt SL ${tradeDirection} ${symbol} @${actualEntry.toFixed(4)}: ${e.msg || e.message}`);
        }

        sidewaysGrid.activeGridPositions.push(gridPos);
        isProcessingTrade = false;
        return gridPos;
    } catch (err) {
        errOccurred = err;
        addLog(`[LƯỚI] LỖI MỞ LỆNH ${tradeDirection} ${symbol}: ${err.msg || err.message}`);
        if (err instanceof CriticalApiError) await stopBotLogicInternal();
        isProcessingTrade = false;
        return null;
    } finally { if(isProcessingTrade && !(errOccurred instanceof CriticalApiError)) isProcessingTrade = false; }
}

async function closeSpecificGridPosition(gridPosObj, reasonForClose, isSlEvent = false, isTpEvent = false) {
    if (!gridPosObj || !gridPosObj.symbol) return;
    isProcessingTrade = true;
    let errOccurred = null;
    addLog(`[LƯỚI] Đóng lệnh ${gridPosObj.side} ${gridPosObj.symbol} ID ${gridPosObj.id} @${gridPosObj.entryPrice.toFixed(gridPosObj.pricePrecision || 4)}. Lý do: ${reasonForClose}`);

    if (gridPosObj.tpOrderId) {
        try {
            await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: gridPosObj.symbol, orderId: gridPosObj.tpOrderId });
            addLog(`  [LƯỚI] Đã hủy TP ${gridPosObj.tpOrderId} cho lệnh lưới.`);
        } catch (e) {
            if (e.code !== -2011) addLog(`  [LƯỚI] Lỗi hủy TP ${gridPosObj.tpOrderId}: ${e.msg || e.message}`);
            else addLog(`  [LƯỚI] TP ${gridPosObj.tpOrderId} có thể đã khớp/hủy.`);
        }
    }
    if (gridPosObj.slOrderId) {
        try {
            await callSignedAPI('/fapi/v1/order', 'DELETE', { symbol: gridPosObj.symbol, orderId: gridPosObj.slOrderId });
            addLog(`  [LƯỚI] Đã hủy SL ${gridPosObj.slOrderId} cho lệnh lưới.`);
        } catch (e) {
            if (e.code !== -2011) addLog(`  [LƯỚI] Lỗi hủy SL ${gridPosObj.slOrderId}: ${e.msg || e.message}`);
            else addLog(`  [LƯỚI] SL ${gridPosObj.slOrderId} có thể đã khớp/hủy.`);
        }
    }
    await sleep(300);

    if (!isSlEvent && !isTpEvent) {
        try {
            const details = await getSymbolDetails(gridPosObj.symbol);
            if(details && gridPosObj.quantity > 0) {
                const qtyClose = parseFloat(gridPosObj.quantity.toFixed(details.quantityPrecision));
                const sideCloseOrder = gridPosObj.side === 'LONG' ? 'SELL' : 'BUY';

                const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: gridPosObj.symbol });
                const currentActualPos = positions.find(p => p.symbol === gridPosObj.symbol && p.positionSide === gridPosObj.side);
                const actualQtyOnExchange = Math.abs(parseFloat(currentActualPos?.positionAmt || "0"));

                if (actualQtyOnExchange >= qtyClose * 0.9) {
                    addLog(`  [LƯỚI] Gửi lệnh MARKET đóng ${qtyClose} ${gridPosObj.side} ${gridPosObj.symbol}`);
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: gridPosObj.symbol,
                        side: sideCloseOrder,
                        positionSide: gridPosObj.side,
                        type: 'MARKET',
                        quantity: qtyClose,
                        newClientOrderId: `GRID-MANCLOSE-${gridPosObj.side[0]}${gridPosObj.stepIndex}-${gridPosObj.id}-${Date.now()}`
                    });
                } else {
                     addLog(`  [LƯỚI] Không đủ KL (${actualQtyOnExchange.toFixed(details.quantityPrecision)}) trên sàn để đóng ${qtyClose} ${gridPosObj.side} ${gridPosObj.symbol}. Có thể đã đóng trước đó.`);
                }
            }
        } catch (err) {
            errOccurred = err;
            addLog(`  [LƯỚI] Lỗi MARKET đóng ${gridPosObj.side} ${gridPosObj.symbol} ID ${gridPosObj.id}: ${err.msg || err.message}`);
        }
    }

    sidewaysGrid.activeGridPositions = sidewaysGrid.activeGridPositions.filter(p => p.id !== gridPosObj.id);
    addLog(`  [LƯỚI] Đã xóa lệnh lưới ID ${gridPosObj.id} khỏi quản lý. Còn ${sidewaysGrid.activeGridPositions.length} lệnh lưới đang hoạt động.`);

    if (isSlEvent) sidewaysGrid.sidewaysStats.slMatchedCount++;
    if (isTpEvent) sidewaysGrid.sidewaysStats.tpMatchedCount++;
    isProcessingTrade = false;
}

async function manageSidewaysGridLogic() {
    if (!sidewaysGrid.isActive || !currentMarketPrice || isProcessingTrade || sidewaysGrid.isClearingForKillSwitch || !TARGET_COIN_SYMBOL) return;

    const details = await getSymbolDetails(TARGET_COIN_SYMBOL);
    if (!details) { addLog("[LƯỚI] Không lấy được symbol details, không thể quản lý lưới."); return; }
    const pricePrecision = details.pricePrecision;

    const posFromCurrentAnchor = sidewaysGrid.activeGridPositions.filter(p => p.originalAnchorPrice === sidewaysGrid.anchorPrice);
    if (posFromCurrentAnchor.length === 0) {
        let sideToOpen = null, targetEntryForOpen = null;
        if (currentMarketPrice >= sidewaysGrid.anchorPrice * (1 + SIDEWAYS_INITIAL_TRIGGER_PERCENT)) {
            sideToOpen = 'SHORT'; targetEntryForOpen = sidewaysGrid.anchorPrice * (1 + SIDEWAYS_INITIAL_TRIGGER_PERCENT);
        } else if (currentMarketPrice <= sidewaysGrid.anchorPrice * (1 - SIDEWAYS_INITIAL_TRIGGER_PERCENT)) {
            sideToOpen = 'LONG'; targetEntryForOpen = sidewaysGrid.anchorPrice * (1 - SIDEWAYS_INITIAL_TRIGGER_PERCENT);
        }
        if (sideToOpen) {
            addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger ban đầu. Mở ${sideToOpen} quanh ${targetEntryForOpen.toFixed(pricePrecision)}.`);
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, sideToOpen, targetEntryForOpen, 0);
        }
    }

    const MAX_STEPS = Math.floor(SIDEWAYS_GRID_RANGE_PERCENT / SIDEWAYS_GRID_STEP_PERCENT);
    for (let i = 1; i <= MAX_STEPS; i++) {
        const shortTriggerPrice = sidewaysGrid.anchorPrice * (1 + i * SIDEWAYS_GRID_STEP_PERCENT);
        if (currentMarketPrice >= shortTriggerPrice && !sidewaysGrid.activeGridPositions.find(p => p.side === 'SHORT' && p.stepIndex === i && p.originalAnchorPrice === sidewaysGrid.anchorPrice)) {
            addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger Short bước ${i} (${shortTriggerPrice.toFixed(pricePrecision)}).`);
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, 'SHORT', shortTriggerPrice, i);
        }

        const longTriggerPrice = sidewaysGrid.anchorPrice * (1 - i * SIDEWAYS_GRID_STEP_PERCENT);
        if (currentMarketPrice <= longTriggerPrice && !sidewaysGrid.activeGridPositions.find(p => p.side === 'LONG' && p.stepIndex === i && p.originalAnchorPrice === sidewaysGrid.anchorPrice)) {
            addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) chạm trigger Long bước ${i} (${longTriggerPrice.toFixed(pricePrecision)}).`);
            await openGridPositionAndSetTPSL(TARGET_COIN_SYMBOL, 'LONG', longTriggerPrice, i);
        }
    }

    if (currentMarketPrice > sidewaysGrid.gridUpperLimit || currentMarketPrice < sidewaysGrid.gridLowerLimit) {
        addLog(`[LƯỚI] Giá (${currentMarketPrice.toFixed(pricePrecision)}) vượt ra ngoài phạm vi lưới (${sidewaysGrid.gridLowerLimit.toFixed(pricePrecision)} - ${sidewaysGrid.gridUpperLimit.toFixed(pricePrecision)}). Dịch chuyển anchor về giá hiện tại.`);
        sidewaysGrid.anchorPrice = currentMarketPrice;
        sidewaysGrid.gridUpperLimit = sidewaysGrid.anchorPrice * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
        sidewaysGrid.gridLowerLimit = sidewaysGrid.anchorPrice * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
        sidewaysGrid.lastGridMoveTime = Date.now();
    }

    if (Date.now() - (sidewaysGrid.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS) {
        sidewaysGrid.lastVolatilityCheckTime = Date.now();
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);

        if (lastCalculatedVolatility >= OVERALL_VOLATILITY_THRESHOLD) {
            addLog(`[LƯỚI] ${TARGET_COIN_SYMBOL} chuyển sang chế độ KILL do biến động mạnh (${lastCalculatedVolatility.toFixed(2)}% > ${OVERALL_VOLATILITY_THRESHOLD}%).`);
            if (!sidewaysGrid.isClearingForKillSwitch) {
                sidewaysGrid.isClearingForKillSwitch = true;
                await closeAllSidewaysPositionsAndOrders(`Chuyển sang KILL (${TARGET_COIN_SYMBOL}) do biến động mạnh`);

                if(sidewaysGrid.killSwitchDelayTimeout) clearTimeout(sidewaysGrid.killSwitchDelayTimeout);

                addLog(`  [LƯỚI] Chờ ${KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS/1000}s trước khi kích hoạt KILL mode cho ${TARGET_COIN_SYMBOL}.`);
                sidewaysGrid.killSwitchDelayTimeout = setTimeout(async () => {
                    addLog(`[LƯỚI] Hết ${KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS/1000}s chờ. Kích hoạt KILL mode cho ${TARGET_COIN_SYMBOL}.`);
                    currentBotMode = 'kill';
                    sidewaysGrid.isClearingForKillSwitch = false;
                    sidewaysGrid.isActive = false;
                    if (currentLongPosition) currentLongPosition = null;
                    if (currentShortPosition) currentShortPosition = null;

                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);

                    if (botRunning) scheduleNextMainCycle(1000);
                }, KILL_MODE_DELAY_AFTER_SIDEWAYS_CLEAR_MS);
            }
            return;
        }
    }
}

async function closeAllSidewaysPositionsAndOrders(reason) {
    if (!TARGET_COIN_SYMBOL) return;
    addLog(`[LƯỚI] Đóng tất cả vị thế và lệnh Sideways cho ${TARGET_COIN_SYMBOL}. Lý do: ${reason}`);

    const activeGridCopy = [...sidewaysGrid.activeGridPositions];
    if (activeGridCopy.length === 0) {
        addLog("  [LƯỚI] Không có vị thế lưới nào đang hoạt động để đóng.");
    }

    for (const pos of activeGridCopy) {
        await closeSpecificGridPosition(pos, `Đóng toàn bộ (${TARGET_COIN_SYMBOL}): ${reason}`);
        await sleep(500);
    }

    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);

    sidewaysGrid.isActive = false;
    sidewaysGrid.anchorPrice = null;
    sidewaysGrid.gridUpperLimit = null; 
    sidewaysGrid.gridLowerLimit = null; 
    sidewaysGrid.activeGridPositions = [];
    sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };
    addLog(`[LƯỚI] Đã hoàn tất đóng và dọn dẹp Sideways cho ${TARGET_COIN_SYMBOL}.`);
}

async function checkOverallTPSL() {
    if (!botRunning) return false;
    let stopReason = null;

    if (targetOverallTakeProfit > 0 && netPNL >= targetOverallTakeProfit) {
        stopReason = `Chốt lời toàn bộ bot (coin ${TARGET_COIN_SYMBOL || 'N/A'}) đạt mục tiêu ${targetOverallTakeProfit.toFixed(2)} USDT (PNL Ròng hiện tại: ${netPNL.toFixed(2)} USDT).`;
    } else if (targetOverallStopLoss < 0 && netPNL <= targetOverallStopLoss) {
        stopReason = `Cắt lỗ toàn bộ bot (coin ${TARGET_COIN_SYMBOL || 'N/A'}) đạt mục tiêu ${targetOverallStopLoss.toFixed(2)} USDT (PNL Ròng hiện tại: ${netPNL.toFixed(2)} USDT).`;
    }

    if (stopReason) {
        addLog(stopReason + " Đang dừng bot...");
        await stopBotLogicInternal();
        return true;
    }
    return false;
}

async function runTradingLogic() {
    if (!botRunning || sidewaysGrid.isClearingForKillSwitch) {
        if(sidewaysGrid.isClearingForKillSwitch) addLog("runTradingLogic: Bot đang trong quá trình dọn lưới để chuyển mode, bỏ qua chu kỳ này.");
        return;
    }
    if (await checkOverallTPSL()) return;

    if (!TARGET_COIN_SYMBOL || (!currentLongPosition && !currentShortPosition && !sidewaysGrid.isActive)) {
        addLog(`TARGET_COIN_SYMBOL (${TARGET_COIN_SYMBOL || 'N/A'}) chưa được đặt hoặc không có lệnh/lưới. Đang chọn coin mới...`);
        const newCoin = await selectTargetCoin(!TARGET_COIN_SYMBOL);
        if (newCoin) {
            if (TARGET_COIN_SYMBOL && TARGET_COIN_SYMBOL !== newCoin) {
                addLog(`TARGET_COIN_SYMBOL thay đổi từ ${TARGET_COIN_SYMBOL} sang ${newCoin}. Dọn dẹp coin cũ.`);
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            }
            TARGET_COIN_SYMBOL = newCoin;
            totalProfit = 0; totalLoss = 0; netPNL = 0;
            lastCalculatedVolatility = 0;
            currentLongPosition = null; currentShortPosition = null;
            sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };

            if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
            setupMarketDataStream(TARGET_COIN_SYMBOL);
            await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
        } else {
            addLog("Không chọn được coin mục tiêu. Bot sẽ thử lại sau 1 phút.");
            if (botRunning) scheduleNextMainCycle(60000);
            return;
        }
    }

    if (!TARGET_COIN_SYMBOL) {
        addLog("Lỗi nghiêm trọng: TARGET_COIN_SYMBOL vẫn là null sau khi cố gắng chọn. Dừng chu kỳ, thử lại sau 1 phút.");
        if (botRunning) scheduleNextMainCycle(60000);
        return;
    }

    if (currentBotMode === 'sideways' && sidewaysGrid.isActive && Date.now() - (lastCoinSwitchCheckTime || 0) > COIN_SWITCH_CHECK_INTERVAL_MS) {
        lastCoinSwitchCheckTime = Date.now();
        addLog(`Đang ở Sideways (${TARGET_COIN_SYMBOL}). Kiểm tra coin biến động cao từ VPS1 để chuyển (nếu có)...`);
        const topCoinsFromVps1 = await fetchTopCoinsFromVPS1();
        const volatileCoinsToConsider = topCoinsFromVps1.filter(c => Math.abs(c.changePercent) >= VOLATILITY_SWITCH_THRESHOLD_PERCENT && c.symbol !== TARGET_COIN_SYMBOL);

        if (volatileCoinsToConsider.length > 0) {
            addLog(`Tìm thấy ${volatileCoinsToConsider.length} coin biến động mạnh: ${volatileCoinsToConsider.map(c=>`${c.symbol} (${c.changePercent}%)`).join(', ')}. Áp dụng delay ${VPS_SPECIFIC_DELAY_MS}ms...`);
            await sleep(VPS_SPECIFIC_DELAY_MS);

            const freshTopCoinsAfterDelay = await fetchTopCoinsFromVPS1();
            const freshVolatileCoins = freshTopCoinsAfterDelay.filter(c => Math.abs(c.changePercent) >= VOLATILITY_SWITCH_THRESHOLD_PERCENT && c.symbol !== TARGET_COIN_SYMBOL);

            let bestNewCoinInfo = null;
            if (freshVolatileCoins.length > 0) {
                 freshVolatileCoins.sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
                 for (const coin of freshVolatileCoins) {
                    const hasPosition = await checkExistingPosition(coin.symbol);
                    await sleep(300);
                    if (!hasPosition) {
                        bestNewCoinInfo = coin;
                        break;
                    } else {
                        addLog(`Coin ${coin.symbol} (${coin.changePercent}%) đã có vị thế sau delay. Bỏ qua.`);
                    }
                }
            }

            if (bestNewCoinInfo && bestNewCoinInfo.symbol !== TARGET_COIN_SYMBOL) {
                addLog(`Quyết định chuyển từ Sideways ${TARGET_COIN_SYMBOL} sang KILL mode cho coin mới ${bestNewCoinInfo.symbol} (Biến động VPS1: ${bestNewCoinInfo.changePercent}%).`);
                await closeAllSidewaysPositionsAndOrders(`Chuyển sang coin mới ${bestNewCoinInfo.symbol} do biến động cao`);

                TARGET_COIN_SYMBOL = bestNewCoinInfo.symbol;
                currentBotMode = 'kill';
                totalProfit = 0; totalLoss = 0; netPNL = 0;
                lastCalculatedVolatility = 0;
                currentLongPosition = null; currentShortPosition = null;

                if (marketWs) { marketWs.removeAllListeners(); marketWs.close(); marketWs = null; }
                setupMarketDataStream(TARGET_COIN_SYMBOL);
                await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);

                if (botRunning) scheduleNextMainCycle(1000);
                return;
            } else {
                addLog("Không có coin mới phù hợp để chuyển sau delay hoặc các coin tiềm năng đã có vị thế.");
            }
        }
    }

    if (Date.now() - (sidewaysGrid.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS * 0.9) {
        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
    }
    const prevMode = currentBotMode;

    if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD && currentBotMode === 'kill' && !currentLongPosition && !currentShortPosition) {
        currentBotMode = 'sideways';
    } else if (lastCalculatedVolatility > OVERALL_VOLATILITY_THRESHOLD && currentBotMode === 'sideways' && !sidewaysGrid.isClearingForKillSwitch) {
    } else if (lastCalculatedVolatility > OVERALL_VOLATILITY_THRESHOLD && currentBotMode !== 'kill' && !sidewaysGrid.isClearingForKillSwitch && !sidewaysGrid.isActive) {
        currentBotMode = 'kill';
    }

    if (prevMode !== currentBotMode && !sidewaysGrid.isClearingForKillSwitch) {
        addLog(`Chế độ thay đổi từ ${prevMode.toUpperCase()} sang ${currentBotMode.toUpperCase()} (Vol ${TARGET_COIN_SYMBOL} 1h: ${lastCalculatedVolatility.toFixed(2)}%)`);
        if (currentBotMode === 'sideways' && (currentLongPosition || currentShortPosition)) {
            addLog("  Đang có lệnh Kill, sẽ không vào Sideways cho đến khi lệnh Kill đóng.");
            currentBotMode = 'kill';
        }
    }

    if (currentBotMode === 'sideways') {
        if (!sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) {
            if (!currentLongPosition && !currentShortPosition) {
                addLog(`[LƯỚI] Kích hoạt chế độ Sideways cho ${TARGET_COIN_SYMBOL}.`);
                const priceAnchor = await getCurrentPrice(TARGET_COIN_SYMBOL);
                if (!priceAnchor) {
                    addLog("  Không lấy được giá anchor cho Sideways. Thử lại sau.");
                    if(botRunning) scheduleNextMainCycle(); return;
                }
                const details = await getSymbolDetails(TARGET_COIN_SYMBOL);
                if(!details) { addLog("  Không lấy được symbol details cho Sideways. Thử lại sau."); if(botRunning) scheduleNextMainCycle(); return; }

                sidewaysGrid.isActive = true;
                sidewaysGrid.anchorPrice = priceAnchor;
                sidewaysGrid.gridUpperLimit = priceAnchor * (1 + SIDEWAYS_GRID_RANGE_PERCENT);
                sidewaysGrid.gridLowerLimit = priceAnchor * (1 - SIDEWAYS_GRID_RANGE_PERCENT);
                sidewaysGrid.lastGridMoveTime = Date.now();
                sidewaysGrid.lastVolatilityCheckTime = Date.now();
                sidewaysGrid.activeGridPositions = [];
                sidewaysGrid.sidewaysStats = { tpMatchedCount: 0, slMatchedCount: 0 };

                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            } else {
                addLog("  Đang có lệnh Kill. Chờ lệnh Kill đóng trước khi vào Sideways.");
                if(botRunning) scheduleNextMainCycle();
            }
        }
    } else if (currentBotMode === 'kill') {
        if (currentLongPosition || currentShortPosition) {
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        if (sidewaysGrid.isClearingForKillSwitch) {
             addLog("  Đang chờ dọn lưới xong để vào lệnh Kill mới.");
             if (botRunning) scheduleNextMainCycle(); return;
        }
        if (sidewaysGrid.isActive) {
            addLog("  Cảnh báo: Muốn vào Kill nhưng lưới vẫn active và không trong trạng thái dọn. Dọn lưới trước.");
            await closeAllSidewaysPositionsAndOrders("Dọn lưới để chuẩn bị vào Kill mode.");
            if (botRunning) scheduleNextMainCycle(); return;
        }

        addLog(`Bắt đầu chu kỳ giao dịch KILL mới cho ${TARGET_COIN_SYMBOL}...`);
        try {
            const maxLev = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLev) {
                addLog("  Không lấy được max leverage. Thử lại sau.");
                if (botRunning) scheduleNextMainCycle(); return;
            }
            const priceNewPair = await getCurrentPrice(TARGET_COIN_SYMBOL);
            if (!priceNewPair) {
                addLog("  Không lấy được giá để mở cặp lệnh Kill. Thử lại sau.");
                if (botRunning) scheduleNextMainCycle(); return;
            }

            currentLongPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'LONG', maxLev, priceNewPair);
            if (!currentLongPosition) {
                addLog("  Lỗi mở lệnh Long cho Kill. Thử lại sau.");
                if (botRunning) scheduleNextMainCycle(); return;
            }
            await sleep(800);

            currentShortPosition = await openMarketPosition(TARGET_COIN_SYMBOL, 'SHORT', maxLev, priceNewPair);
            if (!currentShortPosition) {
                addLog("  Lỗi mở lệnh Short cho Kill. Đóng lệnh Long đã mở.");
                if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi mở SHORT cặp Kill', 'LONG');
                currentLongPosition = null;
                if (botRunning) scheduleNextMainCycle(); return;
            }

            await sleep(1000);
            await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
            await sleep(500);

            let tpslSet = true;
            if (currentLongPosition?.quantity > 0) {
                if (!await setTPAndSLForPosition(currentLongPosition, true)) tpslSet = false;
            }
            await sleep(300);
            if (currentShortPosition?.quantity > 0) {
                if (!await setTPAndSLForPosition(currentShortPosition, true)) tpslSet = false;
            }

            if (!tpslSet) {
                addLog("  Lỗi đặt TP/SL cho cặp lệnh Kill. Đóng cả hai và thử lại.");
                if (currentLongPosition) await closePosition(currentLongPosition.symbol, 'Lỗi TP/SL Kill', 'LONG');
                if (currentShortPosition) await closePosition(currentShortPosition.symbol, 'Lỗi TP/SL Kill', 'SHORT');
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                return;
            }
        } catch (err) {
            addLog(`  Lỗi trong quá trình mở cặp lệnh Kill: ${err.msg || err.message}`);
            if(err instanceof CriticalApiError) await stopBotLogicInternal();
            if(botRunning) scheduleNextMainCycle();
        }
    }

    if(botRunning && !nextScheduledCycleTimeout) {
         scheduleNextMainCycle();
    }

    if (botRunning && !positionCheckInterval && (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition) || currentBotMode === 'sideways' && sidewaysGrid.isActive)) {
        if (positionCheckInterval) clearInterval(positionCheckInterval);
        const checkIntervalMs = currentBotMode === 'kill' ? 5000 : 3000;
        addLog(`Thiết lập interval kiểm tra vị thế (${currentBotMode}) mỗi ${checkIntervalMs/1000}s.`);
        positionCheckInterval = setInterval(async () => {
            if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
                try {
                    await manageOpenPosition();
                } catch (e) {
                    addLog(`Lỗi trong interval manageOpenPosition: ${e.msg || e.message}`);
                    if(e instanceof CriticalApiError) await stopBotLogicInternal();
                }
            } else if ((!botRunning || sidewaysGrid.isClearingForKillSwitch) && positionCheckInterval) {
                addLog("Bot dừng hoặc đang dọn lưới, xóa interval kiểm tra vị thế.");
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
        }, checkIntervalMs);
    } else if (!botRunning && positionCheckInterval) {
        addLog("Bot không chạy, xóa interval kiểm tra vị thế.");
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
}

const manageOpenPosition = async () => {
    if (isProcessingTrade || !botRunning || sidewaysGrid.isClearingForKillSwitch || !TARGET_COIN_SYMBOL) {
        if(isProcessingTrade) addLog("manageOpenPosition: Bỏ qua do isProcessingTrade = true");
        return;
    }
    if (await checkOverallTPSL()) return;

    if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
        if (Date.now() - (sidewaysGrid.lastVolatilityCheckTime || 0) > VOLATILITY_CHECK_INTERVAL_MS) {
            sidewaysGrid.lastVolatilityCheckTime = Date.now();
            await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
            if (lastCalculatedVolatility <= OVERALL_VOLATILITY_THRESHOLD) {
                addLog(`[KILL] Biến động ${TARGET_COIN_SYMBOL} giảm (${lastCalculatedVolatility.toFixed(2)}% <= ${OVERALL_VOLATILITY_THRESHOLD}%), chuyển sang SIDEWAYS.`);
                currentBotMode = 'sideways';
                if (currentLongPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển Sideways (${TARGET_COIN_SYMBOL} vol giảm)`, "LONG");
                if (currentShortPosition) await closePosition(TARGET_COIN_SYMBOL, `Chuyển Sideways (${TARGET_COIN_SYMBOL} vol giảm)`, "SHORT");
                currentLongPosition = null; currentShortPosition = null;

                await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                sidewaysGrid.isActive = false;

                if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
                scheduleNextMainCycle(1000);
                return;
            }
        }
    }

    if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        await manageSidewaysGridLogic();
    } else if (currentBotMode === 'kill') {
        if (!currentLongPosition || !currentShortPosition) {
            if (!currentLongPosition && !currentShortPosition && botRunning) {
                addLog("[KILL] Cả hai lệnh Long và Short đều không còn. Dọn dẹp và bắt đầu chu kỳ mới.");
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            }
            return;
        }
        try {
            const positionsData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            let longPosEx = positionsData.find(p => p.positionSide === 'LONG' && p.symbol === TARGET_COIN_SYMBOL);
            let shortPosEx = positionsData.find(p => p.positionSide === 'SHORT' && p.symbol === TARGET_COIN_SYMBOL);

            if (currentLongPosition) {
                if (longPosEx && Math.abs(parseFloat(longPosEx.positionAmt)) > 0) {
                    currentLongPosition.unrealizedPnl = parseFloat(longPosEx.unRealizedProfit);
                    currentLongPosition.currentPrice = parseFloat(longPosEx.markPrice);
                    currentLongPosition.quantity = Math.abs(parseFloat(longPosEx.positionAmt));
                    currentLongPosition.entryPrice = parseFloat(longPosEx.entryPrice);
                } else {
                    addLog(`[KILL] Vị thế Long ${TARGET_COIN_SYMBOL} không còn trên sàn. Xóa khỏi bot.`);
                    if(currentLongPosition.currentSLId && !currentLongPosition.currentTPId && currentLongPosition.initialMargin > 0) {
                        const estimatedLoss = -(currentLongPosition.initialMargin * (currentLongPosition.partialCloseLossLevels && currentLongPosition.partialCloseLossLevels.length > 0 ? currentLongPosition.partialCloseLossLevels[currentLongPosition.partialCloseLossLevels.length-1]/100 : (currentLongPosition.maxLeverageUsed >= 75 ? 6 : (currentLongPosition.maxLeverageUsed >=50 ? 3 : 2)) )); 
                        totalLoss += Math.abs(estimatedLoss); netPNL = totalProfit - totalLoss;
                        addLog(`  Ước tính PNL lỗ cho Long đóng: ${estimatedLoss.toFixed(2)}. PNL ròng mới: ${netPNL.toFixed(2)}`);
                    }
                    currentLongPosition = null;
                }
            }
            if (currentShortPosition) {
                 if (shortPosEx && Math.abs(parseFloat(shortPosEx.positionAmt)) > 0) {
                    currentShortPosition.unrealizedPnl = parseFloat(shortPosEx.unRealizedProfit);
                    currentShortPosition.currentPrice = parseFloat(shortPosEx.markPrice);
                    currentShortPosition.quantity = Math.abs(parseFloat(shortPosEx.positionAmt));
                    currentShortPosition.entryPrice = parseFloat(shortPosEx.entryPrice);
                } else {
                    addLog(`[KILL] Vị thế Short ${TARGET_COIN_SYMBOL} không còn trên sàn. Xóa khỏi bot.`);
                     if(currentShortPosition.currentSLId && !currentShortPosition.currentTPId && currentShortPosition.initialMargin > 0) {
                        const estimatedLossS = -(currentShortPosition.initialMargin * (currentShortPosition.partialCloseLossLevels && currentShortPosition.partialCloseLossLevels.length > 0 ? currentShortPosition.partialCloseLossLevels[currentShortPosition.partialCloseLossLevels.length-1]/100 : (currentShortPosition.maxLeverageUsed >= 75 ? 6 : (currentShortPosition.maxLeverageUsed >=50 ? 3 : 2)) ));
                        totalLoss += Math.abs(estimatedLossS); netPNL = totalProfit - totalLoss;
                        addLog(`  Ước tính PNL lỗ cho Short đóng: ${estimatedLossS.toFixed(2)}. PNL ròng mới: ${netPNL.toFixed(2)}`);
                     }
                    currentShortPosition = null;
                }
            }

            if (!currentLongPosition || !currentShortPosition) {
                if (!currentLongPosition && !currentShortPosition && botRunning) {
                    addLog("[KILL] Cả hai lệnh Long/Short đều đã đóng. Dọn dẹp chu kỳ.");
                    await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
                } else if (botRunning) {
                    const remainingPos = currentLongPosition || currentShortPosition;
                    if(remainingPos) {
                        addLog(`[KILL] Chỉ còn 1 lệnh ${remainingPos.side} ${TARGET_COIN_SYMBOL}. Chờ xử lý hoặc đóng thủ công.`);
                    }
                }
                return;
            }

            let winningPos = null, losingPos = null;
            if (currentLongPosition.unrealizedPnl >= 0 && currentShortPosition.unrealizedPnl < 0) {
                winningPos = currentLongPosition; losingPos = currentShortPosition;
            } else if (currentShortPosition.unrealizedPnl >= 0 && currentLongPosition.unrealizedPnl < 0) {
                winningPos = currentShortPosition; losingPos = currentLongPosition;
            } else {
                if (currentLongPosition.unrealizedPnl < 0 && currentShortPosition.unrealizedPnl < 0) {
                    let pA = currentLongPosition, pB = currentShortPosition;
                    if (pA.hasClosedAllLossPositionAtLastLevel && pA.quantity === 0 && pB.quantity > 0) {
                        losingPos = pB;
                    } else if (pB.hasClosedAllLossPositionAtLastLevel && pB.quantity === 0 && pA.quantity > 0) {
                        losingPos = pA;
                    }
                    if (losingPos && losingPos.closedLossAmount > 0 && losingPos.pairEntryPrice > 0 && Math.abs(currentMarketPrice - losingPos.pairEntryPrice) <= (losingPos.pairEntryPrice * 0.0005) ) {
                        if (!isProcessingTrade) {
                            addLog(`[KILL REOPEN BOTH LOSS] Lệnh ${losingPos.side} về gần entry cặp. Mở lại phần đã đóng.`);
                            await addPosition(losingPos, losingPos.closedLossAmount, `price_near_pair_entry_reopen_both_loss (${TARGET_COIN_SYMBOL})`);
                        }
                    }
                }
                for (const posChk of [currentLongPosition, currentShortPosition]) {
                    if (!posChk) continue; 
                    const otherP = posChk === currentLongPosition ? currentShortPosition : currentLongPosition;
                    if (otherP && otherP.quantity === 0 && otherP.hasClosedAllLossPositionAtLastLevel && posChk.quantity > 0 && posChk.initialMargin > 0) {
                        const pnlPctChk = (posChk.unrealizedPnl / posChk.initialMargin) * 100;
                        const pnlBaseChk = posChk.pnlBaseForNextMoc || 0;
                        const MOC5_IDX = 4;
                        if (posChk.partialCloseLossLevels && posChk.partialCloseLossLevels.length > MOC5_IDX) {
                            const moc5RelPnl = posChk.partialCloseLossLevels[MOC5_IDX];
                            const threshMoc5 = pnlBaseChk + moc5RelPnl;
                            if (pnlPctChk >= threshMoc5 && posChk.nextPartialCloseLossIndex > MOC5_IDX) {
                                addLog(`[KILL REOPEN MOC5] ${posChk.side} ${TARGET_COIN_SYMBOL} (PNL ${pnlPctChk.toFixed(1)}%) đã vượt Mốc 5 (${threshMoc5.toFixed(1)}%) và lệnh kia đã đóng hết. Mở lại lệnh ${otherP.side}.`);
                                const newLosingLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
                                const reopenedLosing = await openMarketPosition(TARGET_COIN_SYMBOL, otherP.side, newLosingLeverage || otherP.maxLeverageUsed, await getCurrentPrice(TARGET_COIN_SYMBOL));
                                if (reopenedLosing) {
                                    if (otherP.side === 'LONG') currentLongPosition = reopenedLosing;
                                    else currentShortPosition = reopenedLosing;

                                    posChk.pnlBaseForNextMoc = pnlPctChk;
                                    posChk.nextPartialCloseLossIndex = 0;
                                    posChk.hasAdjustedSLToSpecificLevel = {};

                                    reopenedLosing.pnlBaseForNextMoc = 0;
                                    reopenedLosing.nextPartialCloseLossIndex = 0;

                                    await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
                                    await sleep(500);
                                    if (currentLongPosition?.quantity > 0) await setTPAndSLForPosition(currentLongPosition, true);
                                    await sleep(300);
                                    if (currentShortPosition?.quantity > 0) await setTPAndSLForPosition(currentShortPosition, true);
                                    return;
                                }
                            }
                        }
                    }
                }
                return;
            }

            if (winningPos && losingPos && winningPos.partialCloseLossLevels && winningPos.quantity > 0 && losingPos.quantity > 0 && winningPos.initialMargin > 0) {
                const pnlPctWin = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
                const pnlBaseWin = winningPos.pnlBaseForNextMoc || 0;

                if (winningPos.nextPartialCloseLossIndex >= winningPos.partialCloseLossLevels.length) {
                    if (losingPos.quantity > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel) {
                         addLog(`[KILL] Lệnh thắng ${winningPos.side} đã qua hết mốc PNL. Đóng nốt lệnh lỗ ${losingPos.side}.`);
                         await closePosition(losingPos.symbol, `Thắng (${winningPos.side}) qua hết mốc, đóng lỗ (${losingPos.side})`, losingPos.side);
                         losingPos.hasClosedAllLossPositionAtLastLevel = true;
                         losingPos.quantity = 0;
                    }
                    return;
                }

                const targetMocRelPnl = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
                const absThreshMoc = pnlBaseWin + targetMocRelPnl;

                const MOC5_IDX = 4, MOC8_IDX = 7;
                const MOC5_REL_PNL = winningPos.partialCloseLossLevels[MOC5_IDX];
                const MOC8_REL_PNL = winningPos.partialCloseLossLevels[MOC8_IDX];

                if (MOC5_REL_PNL === undefined || MOC8_REL_PNL === undefined) {
                    addLog(`Lỗi: partialCloseLossLevels không đúng định dạng cho ${TARGET_COIN_SYMBOL}. Cần ít nhất 8 mốc.`);
                    return;
                }

                let actionTakenThisCycle = false;
                if (pnlPctWin >= absThreshMoc) {
                    actionTakenThisCycle = true;
                    const mocIdxReached = winningPos.nextPartialCloseLossIndex;
                    addLog(`[KILL MÓC] ${winningPos.side} ${TARGET_COIN_SYMBOL} đạt Mốc ${mocIdxReached + 1} (PNL ${pnlPctWin.toFixed(1)}% >= ngưỡng ${absThreshMoc.toFixed(1)}%).`);

                    let qtyFractionToClose = 0.10;
                    if (mocIdxReached === MOC5_IDX) qtyFractionToClose = 0.20;
                    else if (mocIdxReached >= MOC8_IDX) qtyFractionToClose = 1.00;

                    const qtyToCloseLosing = losingPos.initialQuantity * qtyFractionToClose;

                    if(await closePartialPosition(losingPos, qtyToCloseLosing)) {
                        winningPos.nextPartialCloseLossIndex++;
                        addLog(`  Đã tăng mốc lệnh thắng ${winningPos.side} lên ${winningPos.nextPartialCloseLossIndex + 1}.`);
                    } else {
                        addLog(`  Không thể đóng một phần lệnh lỗ ${losingPos.side}. Mốc lệnh thắng không tăng.`);
                    }

                    if (mocIdxReached === MOC5_IDX && losingPos.quantity > 0 && !winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL] && losingPos.initialMargin > 0) {
                        const slTargetPnlPercentForLosing = MOC8_REL_PNL;
                        const pnlBaseLosingUSD = (losingPos.initialMargin * (losingPos.pnlBaseForNextMoc || 0)) / 100;
                        const targetPnlAtSLLosing_USD = -(losingPos.initialMargin * (slTargetPnlPercentForLosing / 100)) + pnlBaseLosingUSD;

                        const priceChangeForSL = targetPnlAtSLLosing_USD / losingPos.initialQuantity;
                        const slPriceForLosing = parseFloat((losingPos.entryPrice + priceChangeForSL).toFixed(losingPos.pricePrecision));

                        addLog(`  Đạt Mốc 5. Kéo SL lệnh lỗ ${losingPos.side} về giá ${slPriceForLosing.toFixed(losingPos.pricePrecision)} (tương đương PNL ${slTargetPnlPercentForLosing}% từ PNL base ${losingPos.pnlBaseForNextMoc || 0}%).`);

                        if(losingPos.currentSLId) { try { await callSignedAPI('/fapi/v1/order', 'DELETE', {symbol:losingPos.symbol, orderId:losingPos.currentSLId}); losingPos.currentSLId=null;} catch(e){if(e.code !== -2011)addLog(`  Cảnh báo: Lỗi hủy SL cũ ${losingPos.currentSLId} của lệnh lỗ: ${e.msg}`);} }
                        await sleep(200);

                        try {
                            const newSLOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
                                symbol: losingPos.symbol,
                                side: (losingPos.side === 'LONG' ? 'SELL' : 'BUY'),
                                positionSide: losingPos.side,
                                type: 'STOP_MARKET',
                                stopPrice: slPriceForLosing,
                                quantity: losingPos.quantity,
                                timeInForce: 'GTC',
                                closePosition: 'true',
                                newClientOrderId: `KILL-ADJSL-${losingPos.side[0]}${Date.now()}`
                            });
                            if (newSLOrder.orderId) {
                                losingPos.currentSLId = newSLOrder.orderId;
                                winningPos.hasAdjustedSLToSpecificLevel[MOC5_REL_PNL] = true;
                                addLog(`    Đã đặt SL mới ${newSLOrder.orderId} cho lệnh lỗ ${losingPos.side} tại ${slPriceForLosing.toFixed(losingPos.pricePrecision)}.`);
                            }
                        } catch (e) {
                            addLog(`    Lỗi đặt SL mới cho lệnh lỗ ${losingPos.side}: ${e.msg || e.message}. Thử đặt lại TP/SL đầy đủ.`);
                            await setTPAndSLForPosition(losingPos, false);
                        }
                    }

                    if (losingPos.quantity <= 0 || (winningPos.nextPartialCloseLossIndex > MOC8_IDX && actionTakenThisCycle) ) {
                        losingPos.hasClosedAllLossPositionAtLastLevel = true;
                        addLog(`  Lệnh lỗ ${losingPos.side} đã đóng hết hoặc lệnh thắng đã qua Mốc 8.`);
                    }
                }

                const absPnlThreshMoc8 = (winningPos.pnlBaseForNextMoc || 0) + MOC8_REL_PNL;
                if (pnlPctWin >= absPnlThreshMoc8 && !losingPos.hasClosedAllLossPositionAtLastLevel && losingPos.quantity > 0 && !actionTakenThisCycle) {
                     addLog(`[KILL] Lệnh thắng ${winningPos.side} đạt PNL Mốc 8 (${pnlPctWin.toFixed(1)}% >= ${absPnlThreshMoc8.toFixed(1)}%). Đóng nốt lệnh lỗ ${losingPos.side}.`);
                     if(await closePosition(losingPos.symbol, `Đóng nốt ở Mốc 8 lãi lệnh thắng (Kill ${TARGET_COIN_SYMBOL})`, losingPos.side)) {
                        if (losingPos) { losingPos.hasClosedAllLossPositionAtLastLevel = true; losingPos.quantity = 0; }
                     }
                }
            }

            if (losingPos?.closedLossAmount > 0 && !losingPos.hasClosedAllLossPositionAtLastLevel && winningPos?.quantity > 0 && losingPos.pairEntryPrice > 0) {
                const pairEntryPriceOfLosingPos = losingPos.pairEntryPrice;
                const priceTolerance = pairEntryPriceOfLosingPos * 0.0005;

                if (currentMarketPrice && Math.abs(currentMarketPrice - pairEntryPriceOfLosingPos) <= priceTolerance) {
                    if (!isProcessingTrade) {
                        addLog(`[KILL REOPEN] Giá ${TARGET_COIN_SYMBOL} (${currentMarketPrice.toFixed(4)}) về gần entry cặp (${pairEntryPriceOfLosingPos.toFixed(4)}) của lệnh lỗ ${losingPos.side}. Mở lại phần đã đóng.`);
                        await addPosition(losingPos, losingPos.closedLossAmount, `price_near_pair_entry_reopen (${TARGET_COIN_SYMBOL})`);
                    }
                }
            }
        } catch (err) {
            addLog(`Lỗi trong manageOpenPosition (Kill ${TARGET_COIN_SYMBOL}): ` + (err.msg || err.message));
            if(err instanceof CriticalApiError) await stopBotLogicInternal();
        }
    }
};

async function processTradeResult(orderInfo) {
    if (isProcessingTrade && orderInfo.X !== 'FILLED' && orderInfo.X !== 'CANCELED' && orderInfo.X !== 'REJECTED' && orderInfo.X !== 'EXPIRED') {
        return;
    }
    const wasProcessing = isProcessingTrade;
    isProcessingTrade = true;

    const {
        s: symbol, rp: realizedPnlStr, X: orderStatus, i: orderId, ps: positionSide,
        z: filledQtyStr, S: sideOrder, ap: avgPriceStr, ot: orderType,
        origType: originalOrderType, op: stopPriceStr, ci: clientOrderId
    } = orderInfo;

    const filledQty = parseFloat(filledQtyStr);
    const realizedPnl = parseFloat(realizedPnlStr);
    const avgPrice = parseFloat(avgPriceStr);

    if (symbol !== TARGET_COIN_SYMBOL || orderStatus !== 'FILLED' || filledQty === 0) {
        if (TARGET_COIN_SYMBOL && (orderStatus === 'CANCELED' || orderStatus === 'REJECTED' || orderStatus === 'EXPIRED') && symbol === TARGET_COIN_SYMBOL) {
            addLog(`[Trade Update ${TARGET_COIN_SYMBOL}] Lệnh ${clientOrderId || orderId} (${positionSide} ${sideOrder} ${orderType}) bị ${orderStatus}.`);
        }
        if(!wasProcessing) isProcessingTrade = false;
        return;
    }

    addLog(`[Trade FILLED ${TARGET_COIN_SYMBOL}] ClientID: ${clientOrderId || 'N/A'} (ID: ${orderId}) | ${positionSide} ${sideOrder} ${orderType} | KL: ${filledQty.toFixed(4)} @ ${avgPrice.toFixed(4)} | PNL Thực Tế: ${realizedPnl.toFixed(4)} USDT`);

    if (realizedPnl !== 0) {
        if (realizedPnl > 0) totalProfit += realizedPnl;
        else totalLoss += Math.abs(realizedPnl);
        netPNL = totalProfit - totalLoss;
        addLog(`  PNL Ròng cập nhật (${TARGET_COIN_SYMBOL}): ${netPNL.toFixed(2)} (Tổng Lời: ${totalProfit.toFixed(2)}, Tổng Lỗ: ${totalLoss.toFixed(2)})`);
    }

    if (await checkOverallTPSL()) {
        if(!wasProcessing) isProcessingTrade = false;
        return;
    }

    if (sidewaysGrid.isActive && TARGET_COIN_SYMBOL === symbol) {
        const matchedGridPosition = sidewaysGrid.activeGridPositions.find(p => p.tpOrderId === orderId || p.slOrderId === orderId);
        if (matchedGridPosition) {
            const isTpEvent = matchedGridPosition.tpOrderId === orderId;
            const isSlEvent = matchedGridPosition.slOrderId === orderId;
            if (isTpEvent) {
                addLog(`  [LƯỚI TP] Lệnh TP lưới ${matchedGridPosition.side} ${symbol} (ID gốc: ${matchedGridPosition.id}) đã khớp.`);
                await closeSpecificGridPosition(matchedGridPosition, `TP lưới khớp (${TARGET_COIN_SYMBOL})`, false, true);
            } else if (isSlEvent) {
                addLog(`  [LƯỚI SL] Lệnh SL lưới ${matchedGridPosition.side} ${symbol} (ID gốc: ${matchedGridPosition.id}) đã khớp.`);
                await closeSpecificGridPosition(matchedGridPosition, `SL lưới khớp (${TARGET_COIN_SYMBOL})`, true, false);
            }
            if(!wasProcessing) isProcessingTrade = false;
            return;
        }
        if (clientOrderId && clientOrderId.startsWith("GRID-M")) {
        }
    }

    const isLongKillTP = currentLongPosition && orderId === currentLongPosition.currentTPId;
    const isLongKillSL = currentLongPosition && orderId === currentLongPosition.currentSLId;
    const isShortKillTP = currentShortPosition && orderId === currentShortPosition.currentTPId;
    const isShortKillSL = currentShortPosition && orderId === currentShortPosition.currentSLId;

    let closedKillPositionSide = null;
    if (isLongKillTP || isLongKillSL) closedKillPositionSide = 'LONG';
    else if (isShortKillTP || isShortKillSL) closedKillPositionSide = 'SHORT';

    if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === symbol && closedKillPositionSide) {
        addLog(`  [KILL ${isLongKillTP || isShortKillTP ? 'TP' : 'SL'}] Lệnh ${closedKillPositionSide} ${TARGET_COIN_SYMBOL} đã khớp.`);
        const remainingPosition = (closedKillPositionSide === 'LONG') ? currentShortPosition : currentLongPosition;

        if (remainingPosition?.quantity > 0 && remainingPosition.initialMargin > 0) {
            try {
                const posData = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: remainingPosition.symbol });
                const rPosEx = posData.find(p => p.symbol === remainingPosition.symbol && p.positionSide === remainingPosition.side);
                if (rPosEx) {
                    remainingPosition.unrealizedPnl = parseFloat(rPosEx.unRealizedProfit);
                }
            } catch (e) { addLog(`  Lỗi lấy PNL lệnh còn lại: ${e.message}`);}

            if (realizedPnl >= 0) {
                addLog(`  Lệnh ${closedKillPositionSide} đã chốt lời. Đóng nốt lệnh ${remainingPosition.side} còn lại.`);
                await closePosition(remainingPosition.symbol, `Lãi KILL (${closedKillPositionSide} ${TARGET_COIN_SYMBOL}) chốt, đóng nốt lệnh còn lại`, remainingPosition.side);
                await cleanupAndResetCycle(symbol);
            } else {
                addLog(`  Lệnh ${closedKillPositionSide} đã cắt lỗ. Lệnh ${remainingPosition.side} tiếp tục chạy.`);
                remainingPosition.pnlBaseForNextMoc = (remainingPosition.unrealizedPnl / remainingPosition.initialMargin) * 100;
                remainingPosition.nextPartialCloseLossIndex = 0;
                remainingPosition.hasAdjustedSLToSpecificLevel = {};

                await cancelAllOpenOrdersForSymbol(remainingPosition.symbol);
                await sleep(300);
                if (!await setTPAndSLForPosition(remainingPosition, true)) {
                    addLog(`  Lỗi đặt lại TP/SL cho lệnh ${remainingPosition.side} còn lại. Đóng lệnh và reset.`);
                    await closePosition(remainingPosition.symbol, "Lỗi đặt lại TP/SL sau khi lệnh kia SL", remainingPosition.side);
                    await cleanupAndResetCycle(symbol);
                }
            }
        } else {
            addLog("  Không còn lệnh Kill nào khác hoặc lệnh kia đã đóng trước đó. Dọn dẹp chu kỳ.");
            await cleanupAndResetCycle(symbol);
        }

        if (closedKillPositionSide === 'LONG') currentLongPosition = null;
        else if (closedKillPositionSide === 'SHORT') currentShortPosition = null;

    } else if (currentBotMode === 'kill' && TARGET_COIN_SYMBOL === symbol && clientOrderId && (clientOrderId.startsWith("KILL-PARTIAL") || clientOrderId.startsWith("KILL-ADD") || clientOrderId.startsWith("CLOSE-"))) {
        addLog(`  Lệnh ${clientOrderId} đã khớp. Trạng thái vị thế đã được cập nhật trong hàm gọi (hoặc sẽ được cập nhật bởi manageOpenPosition).`);
        await sleep(1000);
        try {
            const positionsAfterUpdate = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: TARGET_COIN_SYMBOL });
            if (currentLongPosition) {
                const lp = positionsAfterUpdate.find(p=>p.symbol === TARGET_COIN_SYMBOL && p.positionSide==='LONG');
                currentLongPosition.quantity = lp ? Math.abs(parseFloat(lp.positionAmt)) : 0;
                if(currentLongPosition.quantity===0) { addLog("  Vị thế Long đã hết."); currentLongPosition=null; }
                else { currentLongPosition.entryPrice = parseFloat(lp.entryPrice); }
            }
            if (currentShortPosition) {
                const sp = positionsAfterUpdate.find(p=>p.symbol === TARGET_COIN_SYMBOL && p.positionSide==='SHORT');
                currentShortPosition.quantity = sp ? Math.abs(parseFloat(sp.positionAmt)) : 0;
                if(currentShortPosition.quantity===0) { addLog("  Vị thế Short đã hết."); currentShortPosition=null; }
                else { currentShortPosition.entryPrice = parseFloat(sp.entryPrice); }
            }
            if(!currentLongPosition && !currentShortPosition && botRunning) {
                addLog("  Cả hai lệnh Kill đều không còn. Dọn dẹp.");
                await cleanupAndResetCycle(TARGET_COIN_SYMBOL);
            }
        } catch (e) { addLog(`  Lỗi cập nhật KL sau lệnh ${clientOrderId} (${TARGET_COIN_SYMBOL}): ` + (e.msg || e.message)); }
    }

    if(!wasProcessing) isProcessingTrade = false;
}

async function cleanupAndResetCycle(symbolToCleanup) {
    if (!symbolToCleanup) return;
    addLog(`Chu kỳ cho ${symbolToCleanup} kết thúc. Dọn dẹp...`);

    if (symbolToCleanup === TARGET_COIN_SYMBOL) {
        if (sidewaysGrid.isActive && !sidewaysGrid.isClearingForKillSwitch) {
            addLog(`  Đang ở Sideways mode. Đóng tất cả vị thế lưới cho ${symbolToCleanup}.`);
            await closeAllSidewaysPositionsAndOrders(`Dọn dẹp chu kỳ cho ${symbolToCleanup}`);
        } else if (sidewaysGrid.isClearingForKillSwitch) {
            addLog(`  Đang trong quá trình dọn lưới cho ${symbolToCleanup}, không dọn thêm.`);
        }
        currentLongPosition = null;
        currentShortPosition = null;
    }

    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        addLog("  Đã xóa interval kiểm tra vị thế.");
    }

    await cancelAllOpenOrdersForSymbol(symbolToCleanup);
    await checkAndHandleRemainingPosition(symbolToCleanup);

    if (botRunning && !sidewaysGrid.isClearingForKillSwitch) {
        addLog(`  Lên lịch cho chu kỳ tiếp theo sau 1 giây.`);
        scheduleNextMainCycle(1000);
    } else if (sidewaysGrid.isClearingForKillSwitch) {
        addLog("  Bot đang dọn lưới, sẽ không tự lên lịch chu kỳ mới ngay.");
    }
}

async function startBotLogicInternal() {
    if (botRunning) { addLog('Bot đã chạy rồi.'); return 'Bot đã chạy.'; }
    if (!API_KEY || !SECRET_KEY || API_KEY === 'YOUR_BINANCE_API_KEY' || SECRET_KEY === 'YOUR_BINANCE_SECRET_KEY') {
        addLog('Lỗi: Thiếu API_KEY hoặc SECRET_KEY hợp lệ trong config.js.');
        return 'Lỗi: Thiếu API_KEY hoặc SECRET_KEY hợp lệ trong config.js.';
    }

    if (retryBotTimeout) { clearTimeout(retryBotTimeout); retryBotTimeout = null; }
    addLog('--- Khởi động Bot ---');

    try {
        await syncServerTime();
        await getExchangeInfo();

        TARGET_COIN_SYMBOL = await selectTargetCoin(true);
        if (!TARGET_COIN_SYMBOL) {
            throw new Error("Không thể chọn coin mục tiêu ban đầu từ VPS1. Kiểm tra VPS1 hoặc kết nối.");
        }
        addLog(`Coin mục tiêu ban đầu được chọn: ${TARGET_COIN_SYMBOL}`);

        sidewaysGrid = { isActive: false, anchorPrice: null, gridUpperLimit: null, gridLowerLimit: null, lastGridMoveTime: null, activeGridPositions: [], sidewaysStats: { tpMatchedCount: 0, slMatchedCount: 0 }, lastVolatilityCheckTime: 0, isClearingForKillSwitch: false, killSwitchDelayTimeout: null };
        totalProfit=0; totalLoss=0; netPNL=0;
        currentLongPosition = null; currentShortPosition = null;
        lastCalculatedVolatility = 0;
        isProcessingTrade = false;
        consecutiveApiErrors = 0;

        await calculateVolatilityLastHour(TARGET_COIN_SYMBOL);
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        listenKey = await getListenKey();
        if (listenKey) {
            setupUserDataStream(listenKey);
        } else {
            addLog("Không lấy được listenKey, User Data Stream sẽ không hoạt động. Bot vẫn có thể chạy nhưng sẽ không nhận được update lệnh qua WebSocket.");
        }
        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy: ${formatTimeUTC7(botStartTime)} | Coin: ${TARGET_COIN_SYMBOL} | Vốn mặc định: ${INITIAL_INVESTMENT_AMOUNT} USDT ---`);
        addLog(`  Delay chuyển coin ngẫu nhiên: ${VPS_SPECIFIC_DELAY_MS}ms`);
        addLog(`  Chốt lời tổng mục tiêu: ${targetOverallTakeProfit > 0 ? targetOverallTakeProfit + ' USDT' : 'Không giới hạn'}`);
        addLog(`  Cắt lỗ tổng mục tiêu: ${targetOverallStopLoss < 0 ? targetOverallStopLoss + ' USDT' : 'Không giới hạn'}`);

        scheduleNextMainCycle(1000);
        return 'Bot khởi động thành công.';

    } catch (err) {
        const errorMessage = err.msg || err.message || 'Lỗi không xác định khi khởi động';
        addLog(`Lỗi nghiêm trọng khi khởi động bot: ${errorMessage}`);
        botRunning = false;

        if (!(err instanceof CriticalApiError && (errorMessage.includes("API_KEY") || errorMessage.includes("SECRET_KEY"))) && !retryBotTimeout) {
            addLog(`Sẽ thử khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000} giây.`);
            retryBotTimeout = setTimeout(async () => {
                retryBotTimeout = null;
                addLog("Đang thử khởi động lại bot...");
                await startBotLogicInternal();
            }, ERROR_RETRY_DELAY_MS);
        } else if (retryBotTimeout) {
            addLog("Đang trong quá trình chờ retry, không đặt thêm timeout.");
        }
        return `Lỗi khởi động bot: ${errorMessage}. Xem log để biết chi tiết.`;
    }
}

async function stopBotLogicInternal() {
    if (!botRunning && !retryBotTimeout) { addLog('Bot không chạy hoặc không đang retry.'); return 'Bot không chạy.';}
    addLog('--- Dừng Bot ---');
    botRunning = false;

    if(nextScheduledCycleTimeout) { clearTimeout(nextScheduledCycleTimeout); nextScheduledCycleTimeout = null; }
    if (positionCheckInterval) { clearInterval(positionCheckInterval); positionCheckInterval = null; }
    if (sidewaysGrid.killSwitchDelayTimeout) { clearTimeout(sidewaysGrid.killSwitchDelayTimeout); sidewaysGrid.killSwitchDelayTimeout = null; }

    sidewaysGrid.isClearingForKillSwitch = false;
    if (sidewaysGrid.isActive) {
        closeAllSidewaysPositionsAndOrders("Bot dừng").catch(e => addLog(`Lỗi khi đóng lệnh lưới lúc dừng bot: ${e.message}`));
    }
    sidewaysGrid.isActive = false;
    sidewaysGrid.activeGridPositions = [];

    if (listenKeyRefreshInterval) { clearInterval(listenKeyRefreshInterval); listenKeyRefreshInterval = null; }
    if (marketWs) { marketWs.removeAllListeners(); marketWs.terminate(); marketWs = null; addLog("Market Data Stream đã đóng."); }
    if (userDataWs) { userDataWs.removeAllListeners(); userDataWs.terminate(); userDataWs = null; addLog("User Data Stream đã đóng."); }

    if (listenKey) {
        try {
            await callSignedAPI('/fapi/v1/listenKey', 'DELETE', { listenKey });
            addLog("ListenKey đã được xóa.");
        }
        catch (e) { addLog(`Lỗi xóa listenKey: ${e.msg || e.message}`); }
        listenKey = null;
    }

    if (currentLongPosition && TARGET_COIN_SYMBOL) {
        addLog(`Đang đóng vị thế Long ${TARGET_COIN_SYMBOL} do bot dừng.`);
        closePosition(TARGET_COIN_SYMBOL, "Bot dừng", "LONG").catch(e => addLog(`Lỗi đóng Long ${TARGET_COIN_SYMBOL} lúc dừng: ${e.message}`));
    }
    if (currentShortPosition && TARGET_COIN_SYMBOL) {
        addLog(`Đang đóng vị thế Short ${TARGET_COIN_SYMBOL} do bot dừng.`);
        closePosition(TARGET_COIN_SYMBOL, "Bot dừng", "SHORT").catch(e => addLog(`Lỗi đóng Short ${TARGET_COIN_SYMBOL} lúc dừng: ${e.message}`));
    }

    if (TARGET_COIN_SYMBOL) {
        await cancelAllOpenOrdersForSymbol(TARGET_COIN_SYMBOL);
    }

    currentLongPosition = null; currentShortPosition = null;
    lastCoinSwitchCheckTime = 0;
    isProcessingTrade = false;

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog("Đã hủy retry khởi động bot (nếu có).");
    }
    addLog('--- Bot đã dừng ---');
    return 'Bot đã dừng.';
}

async function checkAndHandleRemainingPosition(symbolToCheck) {
    if (!symbolToCheck) return;
    addLog(`Kiểm tra và xử lý vị thế sót cho ${symbolToCheck}...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET', { symbol: symbolToCheck });
        const remainingPositions = positions.filter(p => p.symbol === symbolToCheck && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế còn lại cho ${symbolToCheck}. Đang đóng...`);
            await cancelAllOpenOrdersForSymbol(symbolToCheck);
            await sleep(500);

            for (const pos of remainingPositions) {
                const sideToCloseOrder = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
                const positionSideActual = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const qtyToClose = Math.abs(parseFloat(pos.positionAmt));

                addLog(`  Đóng MARKET ${qtyToClose} ${symbolToCheck} (Vị thế ${positionSideActual}) do dọn dẹp.`);
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: pos.symbol,
                    side: sideToCloseOrder,
                    positionSide: positionSideActual,
                    type: 'MARKET',
                    quantity: qtyToClose,
                    newClientOrderId: `CLEANUP-${positionSideActual[0]}-${Date.now()}`
                });
                await sleep(1000);
            }
            addLog(`Hoàn tất đóng vị thế sót cho ${symbolToCheck}.`);
        } else {
            addLog(`Không có vị thế sót nào cho ${symbolToCheck}.`);
        }
    } catch (error) {
        addLog(`Lỗi dọn vị thế sót cho ${symbolToCheck}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError && botRunning) await stopBotLogicInternal();
    }
}

function scheduleNextMainCycle(delayMs = 5000) {
    if (!botRunning) return;
    if(nextScheduledCycleTimeout) clearTimeout(nextScheduledCycleTimeout);

    nextScheduledCycleTimeout = setTimeout(async () => {
        if (botRunning && !isProcessingTrade && !sidewaysGrid.isClearingForKillSwitch) {
            try {
                await runTradingLogic();
            } catch (e) {
                addLog(`Lỗi trong chu kỳ chính runTradingLogic (${TARGET_COIN_SYMBOL || 'N/A'}): ${e.msg || e.message} ${e.stack ? '\nStack: ' + e.stack.substring(0,300) : ''}`);
                if (e instanceof CriticalApiError) {
                    addLog("  Lỗi nghiêm trọng, dừng bot.");
                    await stopBotLogicInternal();
                } else if (botRunning) {
                    addLog("  Lên lịch lại chu kỳ chính sau 15 giây do lỗi không nghiêm trọng.");
                    scheduleNextMainCycle(15000);
                }
            }
        } else if (botRunning) {
             scheduleNextMainCycle(delayMs);
        }
    }, delayMs);
}

async function getListenKey() {
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
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: key });
        addLog("Gia hạn ListenKey thành công.");
    } catch (e) {
        addLog(`Lỗi gia hạn listenKey: ${e.msg || e.message}. Sẽ thử lấy key mới nếu stream đóng.`);
    }
}

function setupUserDataStream(key) {
    if (!key) {
        addLog("Không có listenKey, không thể thiết lập User Data Stream.");
        return;
    }
    if (userDataWs && (userDataWs.readyState === WebSocket.OPEN || userDataWs.readyState === WebSocket.CONNECTING)) {
        addLog("User Data Stream đã tồn tại, đóng stream cũ trước khi tạo mới...");
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
        listenKeyRefreshInterval = setInterval(() => keepAliveListenKey(key), 30 * 60 * 1000);
    });
    userDataWs.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message.e === 'ORDER_TRADE_UPDATE') {
                await processTradeResult(message.o);
            } else if (message.e === 'ACCOUNT_UPDATE') {
            } else if (message.e === 'listenKeyExpired') {
                addLog("User Data Stream: ListenKey đã hết hạn. Đang lấy key mới và kết nối lại...");
                if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
                listenKey = await getListenKey();
                if (listenKey) setupUserDataStream(listenKey);
            }
        } catch (error) { addLog('Lỗi xử lý User Data Stream message: ' + error.message + `. Data: ${data.toString().substring(0,200)}`); }
    });
    userDataWs.on('error', (err) => addLog('Lỗi User Data Stream: ' + err.message));
    userDataWs.on('close', async (code, reason) => {
        addLog(`User Data Stream đã đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}.`);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
        if (botRunning) {
            addLog("  Thử kết nối lại User Data Stream sau 5 giây...");
            await sleep(5000);
            listenKey = await getListenKey();
            if (listenKey) setupUserDataStream(listenKey);
            else addLog("  Không lấy được listenKey mới, không thể kết nối lại User Data Stream.");
        }
    });
}

function setupMarketDataStream(symbol) {
    if (!symbol) { addLog("Không có symbol để stream market data."); return; }
    if (marketWs && (marketWs.readyState === WebSocket.OPEN || marketWs.readyState === WebSocket.CONNECTING)) {
        const oldSymbol = marketWs.url.split('/').pop().split('@')[0].toUpperCase();
        addLog(`Đóng Market Data Stream cũ cho ${oldSymbol}...`);
        marketWs.removeAllListeners();
        marketWs.terminate();
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
            if (message.e === 'markPriceUpdate' && message.s === TARGET_COIN_SYMBOL) {
                currentMarketPrice = parseFloat(message.p);
                if(currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice;
                if(currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice;
            }
        } catch (error) { addLog(`Lỗi xử lý Market Data Stream message (${symbol}): ` + error.message + `. Data: ${data.toString().substring(0,100)}`); }
    });
    marketWs.on('error', (err) => addLog(`Lỗi Market Data Stream (${symbol}): ` + err.message));
    marketWs.on('close', (code, reason) => {
        const closedSymbol = marketWs && marketWs.url ? marketWs.url.split('/').pop().split('@')[0].toUpperCase() : symbol;
        addLog(`Market Data Stream (${closedSymbol}) đã đóng. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}.`);
        if (botRunning && closedSymbol === TARGET_COIN_SYMBOL) {
            addLog(`Thử kết nối lại Market Data Stream cho ${TARGET_COIN_SYMBOL} sau 5 giây...`);
            setTimeout(() => setupMarketDataStream(TARGET_COIN_SYMBOL), 5000);
        } else if (botRunning && closedSymbol !== TARGET_COIN_SYMBOL) {
            addLog(`Market stream cho coin cũ ${closedSymbol} đã đóng, không kết nối lại vì coin hiện tại là ${TARGET_COIN_SYMBOL}.`);
        } else {
             addLog(`Không kết nối lại Market Data Stream cho ${closedSymbol} (Bot dừng).`);
        }
    });
}

const app = express();
app.use(express.json());
const staticPath = path.join(__dirname, 'public');
if (!fs.existsSync(staticPath)){
    fs.mkdirSync(staticPath, { recursive: true });
    addLog(`Đã tạo thư mục 'public' tại ${staticPath}. Hãy đặt file HTML điều khiển của bạn vào đây.`);
}
app.use(express.static(staticPath));


app.get('/', (req, res) => {
    const indexPath = path.join(staticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("<h1>Bot Client</h1><p>Không tìm thấy file index.html trong thư mục public.</p><p>Vui lòng đặt file HTML điều khiển của bạn vào thư mục 'public' cùng cấp với file bot_client.js này.</p>");
    }
});

app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            addLog(`Lỗi đọc file log ${CUSTOM_LOG_FILE}: ${err.message}`);
            return res.status(500).send('Lỗi đọc log. Kiểm tra console của server.');
        }
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        res.type('text/plain').send(cleanData.split('\n').slice(-500).join('\n'));
    });
});

app.get('/api/status', async (req, res) => {
    let pm2Status = "Không thể lấy trạng thái PM2.";
    try {
        const pm2ListOutput = await new Promise((resolve, reject) => {
            exec('pm2 jlist', {timeout: 3000}, (error, stdout, stderr) => { 
                if (error) { return reject(new Error(`PM2 jlist error: ${stderr || error.message}`)); }
                resolve(stdout);
            });
        });
        const processes = JSON.parse(pm2ListOutput);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME || (p.pm2_env && p.pm2_env.PORT && parseInt(p.pm2_env.PORT) === WEB_SERVER_PORT));

        if (botProcess) {
            pm2Status = `MÁY CHỦ (PM2 ${botProcess.name}): ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time}, Uptime: ${Math.floor(botProcess.pm2_env.pm_uptime / (1000*60))}p)`;
        } else {
            pm2Status = `Bot PM2 '${THIS_BOT_PM2_NAME}' (Port ${WEB_SERVER_PORT}) không tìm thấy trong danh sách PM2.`;
        }
    } catch (err) {
        pm2Status = `Lỗi lấy trạng thái PM2: ${err.message}. PM2 có thể chưa cài hoặc không chạy.`;
    }

    let botStatusMsg = `${pm2Status} | BOT LOGIC: ${botRunning ? 'CHẠY' : 'DỪNG'}`;
    if (botStartTime && botRunning) botStatusMsg += ` | Uptime Bot: ${Math.floor((Date.now() - botStartTime.getTime()) / 60000)} phút`;
    botStatusMsg += ` | Coin: ${TARGET_COIN_SYMBOL || "CHƯA CHỌN"} | Vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
    botStatusMsg += ` | Mode: ${currentBotMode.toUpperCase()} (Vol 1h: ${lastCalculatedVolatility.toFixed(1)}%)`;
    if(sidewaysGrid.isClearingForKillSwitch) botStatusMsg += " (ĐANG DỌN LƯỚI)";

    let positionText = "";
    if (currentBotMode === 'kill' && (currentLongPosition || currentShortPosition)) {
        positionText = " | Vị thế KILL: ";
        if(currentLongPosition) {
            const pnlL = currentLongPosition.unrealizedPnl !== undefined ? currentLongPosition.unrealizedPnl : ((currentLongPosition.currentPrice - currentLongPosition.entryPrice) * currentLongPosition.quantity);
            positionText += `L(KL:${currentLongPosition.quantity.toFixed(currentLongPosition.quantityPrecision || 3)} PNL:${pnlL.toFixed(1)} PNLb:${(currentLongPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${(currentLongPosition.nextPartialCloseLossIndex || 0) +1}) `;
        }
        if(currentShortPosition) {
            const pnlS = currentShortPosition.unrealizedPnl !== undefined ? currentShortPosition.unrealizedPnl : ((currentShortPosition.entryPrice - currentShortPosition.currentPrice) * currentShortPosition.quantity);
            positionText += `S(KL:${currentShortPosition.quantity.toFixed(currentShortPosition.quantityPrecision || 3)} PNL:${pnlS.toFixed(1)} PNLb:${(currentShortPosition.pnlBaseForNextMoc || 0).toFixed(0)}% M${(currentShortPosition.nextPartialCloseLossIndex || 0) +1})`;
        }
    } else if (currentBotMode === 'sideways' && sidewaysGrid.isActive) {
        const details = TARGET_COIN_SYMBOL ? await getSymbolDetails(TARGET_COIN_SYMBOL) : null;
        const pricePrecision = details ? details.pricePrecision : 4;
        positionText = ` | Vị thế LƯỚI: ${sidewaysGrid.activeGridPositions.length} lệnh. Anchor: ${sidewaysGrid.anchorPrice?.toFixed(pricePrecision)}. SLs: ${sidewaysGrid.sidewaysStats.slMatchedCount}, TPs: ${sidewaysGrid.sidewaysStats.tpMatchedCount}`;
    } else {
        positionText = " | Vị thế: --";
    }
    botStatusMsg += positionText;
    botStatusMsg += ` | PNL Ròng (${TARGET_COIN_SYMBOL || 'N/A'}): ${netPNL.toFixed(2)} (L: ${totalProfit.toFixed(2)}, T: ${totalLoss.toFixed(2)})`;
    botStatusMsg += ` | TP Tổng: ${targetOverallTakeProfit > 0 ? targetOverallTakeProfit : 'N/A'}, SL Tổng: ${targetOverallStopLoss < 0 ? targetOverallStopLoss : 'N/A'}`;

    res.type('text/plain').send(botStatusMsg);
});

app.get('/api/bot_stats', async (req, res) => { 
    let killPositionsData = [];
    if (currentBotMode === 'kill') {
        for (const p of [currentLongPosition, currentShortPosition]) { 
            if (p) {
                const details = await getSymbolDetails(p.symbol);
                const pricePrecision = details ? details.pricePrecision : 2;
                const quantityPrecision = details ? details.quantityPrecision : 3;

                const pnl = p.unrealizedPnl !== undefined ? p.unrealizedPnl :
                            (p.side === 'LONG' ? (p.currentPrice - p.entryPrice) * p.quantity : (p.entryPrice - p.currentPrice) * p.quantity);
                killPositionsData.push({
                    type: 'kill', side: p.side,
                    entry: p.entryPrice?.toFixed(pricePrecision),
                    qty: p.quantity?.toFixed(quantityPrecision),
                    pnl: pnl.toFixed(2),
                    curPrice: p.currentPrice?.toFixed(pricePrecision),
                    initQty: p.initialQuantity?.toFixed(quantityPrecision),
                    closedLossQty: p.closedLossAmount?.toFixed(quantityPrecision),
                    pairEntry: p.pairEntryPrice?.toFixed(pricePrecision),
                    mocIdx: (p.nextPartialCloseLossIndex || 0) +1,
                    pnlBasePercent: (p.pnlBaseForNextMoc || 0).toFixed(2),
                    tpId: p.currentTPId, slId: p.currentSLId
                });
            }
        }
    }

    let gridPositionsData = [];
    if (sidewaysGrid.isActive && sidewaysGrid.activeGridPositions.length > 0) {
        for (const p of sidewaysGrid.activeGridPositions) {
            const details = await getSymbolDetails(p.symbol);
            const pricePrecisionGrid = details ? details.pricePrecision : 4;
            const quantityPrecisionGrid = details ? details.quantityPrecision : 4;
            let pnlUnreal = 0;
            if (currentMarketPrice && p.entryPrice && p.quantity) {
                pnlUnreal = (currentMarketPrice - p.entryPrice) * p.quantity * (p.side === 'LONG' ? 1 : -1);
            }
            gridPositionsData.push({
                type: 'grid', id: p.id, side: p.side,
                entry: p.entryPrice?.toFixed(pricePrecisionGrid),
                qty: p.quantity?.toFixed(quantityPrecisionGrid),
                curPrice: currentMarketPrice?.toFixed(pricePrecisionGrid),
                pnl: pnlUnreal.toFixed(2),
                originalAnchor: p.originalAnchorPrice?.toFixed(pricePrecisionGrid),
                step: p.stepIndex,
                tpId: p.tpOrderId, slId: p.slOrderId
            });
        }
    }
    const currentCoinDetails = TARGET_COIN_SYMBOL ? await getSymbolDetails(TARGET_COIN_SYMBOL) : null;
    const currentCoinPricePrecision = currentCoinDetails ? currentCoinDetails.pricePrecision : 4;

    res.json({
        success: true,
        data: {
            botRunning: botRunning,
            currentMode: currentBotMode.toUpperCase(),
            volatilityLastHour: lastCalculatedVolatility.toFixed(2),
            totalProfit: totalProfit.toFixed(2),
            totalLoss: totalLoss.toFixed(2),
            netPNL: netPNL.toFixed(2),
            currentCoin: TARGET_COIN_SYMBOL || "CHƯA CHỌN",
            initialInvestment: INITIAL_INVESTMENT_AMOUNT,
            targetOverallTakeProfit: targetOverallTakeProfit,
            targetOverallStopLoss: targetOverallStopLoss,
            killPositions: killPositionsData,
            sidewaysGridInfo: {
                isActive: sidewaysGrid.isActive,
                isClearingForKillSwitch: sidewaysGrid.isClearingForKillSwitch,
                anchorPrice: sidewaysGrid.anchorPrice?.toFixed(currentCoinPricePrecision),
                upperLimit: sidewaysGrid.gridUpperLimit?.toFixed(currentCoinPricePrecision),
                lowerLimit: sidewaysGrid.gridLowerLimit?.toFixed(currentCoinPricePrecision),
                stats: { tpCount: sidewaysGrid.sidewaysStats.tpMatchedCount, slCount: sidewaysGrid.sidewaysStats.slMatchedCount },
                activePositions: gridPositionsData
            },
            vps1DataUrl: VPS1_DATA_URL,
            botStartTime: botStartTime ? formatTimeUTC7(botStartTime) : "N/A",
            currentMarketPrice: currentMarketPrice?.toFixed(currentCoinPricePrecision)
        }
    });
});

app.post('/api/configure', (req, res) => {
    const { initialAmount, overallTakeProfit, overallStopLoss } = req.body;
    let changesMade = [];
    let errors = [];

    if (initialAmount !== undefined) {
        const newInitialAmount = parseFloat(initialAmount);
        if (!isNaN(newInitialAmount) && newInitialAmount > 0) {
            if (newInitialAmount !== INITIAL_INVESTMENT_AMOUNT) {
                INITIAL_INVESTMENT_AMOUNT = newInitialAmount;
                changesMade.push(`Vốn đầu tư mỗi lệnh Kill đổi thành ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
                if (botRunning) changesMade.push("  LƯU Ý: Thay đổi vốn sẽ áp dụng cho các lệnh Kill MỚI.");
            }
        } else {
            errors.push("Vốn đầu tư không hợp lệ (phải là số > 0).");
        }
    }

    if (overallTakeProfit !== undefined) {
        const newOverallTP = parseFloat(overallTakeProfit);
        if (!isNaN(newOverallTP)) {
            if (newOverallTP !== targetOverallTakeProfit) {
                targetOverallTakeProfit = newOverallTP;
                changesMade.push(`Chốt lời tổng của bot đổi thành ${targetOverallTakeProfit > 0 ? targetOverallTakeProfit + ' USDT' : 'Không giới hạn'}.`);
            }
        } else {
            errors.push("Chốt lời tổng không hợp lệ (phải là số).");
        }
    }

    if (overallStopLoss !== undefined) {
        const newOverallSL = parseFloat(overallStopLoss);
         if (!isNaN(newOverallSL)) {
            if (newOverallSL !== targetOverallStopLoss) {
                targetOverallStopLoss = newOverallSL;
                changesMade.push(`Cắt lỗ tổng của bot đổi thành ${targetOverallStopLoss < 0 ? targetOverallStopLoss + ' USDT' : (targetOverallStopLoss === 0 ? 'Không giới hạn' : targetOverallStopLoss + ' USDT (CẢNH BÁO: SL dương?)')}.`);
            }
        } else {
            errors.push("Cắt lỗ tổng không hợp lệ (phải là số).");
        }
    }

    let message;
    if (errors.length > 0) {
        message = "Lỗi cấu hình: " + errors.join(" ");
        if (changesMade.length > 0) message += " Một số thay đổi hợp lệ đã được áp dụng: " + changesMade.join(" ");
        addLog(`Cấu hình API thất bại: ${message}`);
        res.status(400).json({ success: false, message });
    } else if (changesMade.length > 0) {
        message = "Cấu hình đã cập nhật: " + changesMade.join(" ");
        addLog(message);
        res.json({ success: true, message });
    } else {
        message = "Không có thay đổi nào được thực hiện cho cấu hình.";
        res.json({ success: true, message });
    }
});

app.get('/start_bot_logic', async (req, res) => res.send(await startBotLogicInternal()));
app.get('/stop_bot_logic', async (req, res) => res.send(await stopBotLogicInternal()));

const fallbackHtmlContent = `
<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Bot Control</title>
<style>body{font-family: sans-serif; margin: 20px;} h1{color: #333;} button{margin: 5px; padding: 10px 15px; cursor: pointer;} #status, #logs { white-space: pre-wrap; background: #f4f4f4; border: 1px solid #ddd; padding: 10px; margin-top:10px; max-height: 300px; overflow-y: auto; } .config-item{margin-bottom:10px;}</style>
</head><body><h1>Bot Control Panel</h1>
<p><i>File index.html không tìm thấy trong thư mục 'public'. Đây là giao diện cơ bản.</i></p>
<button onclick="fetch('/start_bot_logic').then(r=>r.text()).then(t=>alert(t))">Start Bot</button>
<button onclick="fetch('/stop_bot_logic').then(r=>r.text()).then(t=>alert(t))">Stop Bot</button>
<div><h3>Cấu Hình Bot</h3>
  <div class="config-item">Vốn mỗi lệnh Kill: <input type="number" id="initialAmount" step="0.01" value="${INITIAL_INVESTMENT_AMOUNT}"> USDT</div>
  <div class="config-item">Chốt lời tổng: <input type="number" id="overallTP" step="0.1" value="${targetOverallTakeProfit}"> USDT (0 = không giới hạn)</div>
  <div class="config-item">Cắt lỗ tổng: <input type="number" id="overallSL" step="0.1" value="${targetOverallStopLoss}"> USDT (Số âm, 0 = không giới hạn)</div>
  <button onclick="updateConfig()">Cập Nhật Cấu Hình</button>
</div>
<h3>Trạng Thái Bot</h3><div id="status">Đang tải...</div>
<h3>Logs (500 dòng cuối)</h3><div id="logs">Đang tải...</div>
<script>
function updateConfig() {
  const payload = {
    initialAmount: document.getElementById('initialAmount').value,
    overallTakeProfit: document.getElementById('overallTP').value,
    overallStopLoss: document.getElementById('overallSL').value
  };
  fetch('/api/configure', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })
  .then(r => r.json()).then(d => alert(d.message || (d.success ? 'Cập nhật thành công' : 'Cập nhật thất bại')));
}
function fetchStatus() { fetch('/api/status').then(r=>r.text()).then(t=>document.getElementById('status').innerText=t); }
function fetchLogs() { fetch('/api/logs').then(r=>r.text()).then(t=>document.getElementById('logs').innerText=t); }
setInterval(fetchStatus, 3000); setInterval(fetchLogs, 10000);
fetchStatus(); fetchLogs();
</script></body></html>`;

(async () => {
    try {
        if (!API_KEY || !SECRET_KEY || API_KEY === 'YOUR_BINANCE_API_KEY' || SECRET_KEY === 'YOUR_BINANCE_SECRET_KEY') {
            addLog("LỖI NGHIÊM TRỌNG: API_KEY hoặc SECRET_KEY không được định nghĩa hoặc chưa được thay đổi trong config.js. Bot sẽ không thể hoạt động với Binance.");
        }
        await syncServerTime();
        await getExchangeInfo();

        http.createServer(app).listen(WEB_SERVER_PORT, '0.0.0.0', () => {
            addLog(`Web server của Bot Client (HTTP) đang chạy tại http://<YOUR_VPS2_IP>:${WEB_SERVER_PORT}`);
            addLog(`Log file: ${CUSTOM_LOG_FILE}`);
            addLog(`Giao diện web (nếu có file public/index.html): http://<YOUR_VPS2_IP>:${WEB_SERVER_PORT}/`);
        });
    } catch (e) {
        addLog(`LỖI NGHIÊM TRỌNG KHI KHỞI TẠO SERVER HOẶC BINANCE API BAN ĐẦU: ${e.msg || e.message}. Bot có thể không hoạt động đúng.`);
         http.createServer(app).listen(WEB_SERVER_PORT, '0.0.0.0', () => {
            addLog(`Web server của Bot Client (CHẾ ĐỘ LỖI - HTTP) đang chạy tại http://<YOUR_VPS2_IP>:${WEB_SERVER_PORT}`);
        });
    }
})();

process.on('unhandledRejection', (reason, promise) => {
  addLog(`Unhandled Rejection at: ${promise}, reason: ${reason?.stack || reason}`);
});

process.on('uncaughtException', (error) => {
  addLog(`Uncaught Exception: ${error.stack || error}`);
  if (botRunning) {
    stopBotLogicInternal().finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
