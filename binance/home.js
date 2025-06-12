import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// Import API_KEY và SECRET_KEY từ config.js
import { API_KEY, SECRET_KEY } from './config.js';

// Lấy __filename và __dirname trong ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com';
const WS_USER_DATA_ENDPOINT = '/ws';

let serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance
let exchangeInfoCache = null; // Biến cache cho exchangeInfo để tránh gọi API lặp lại
let isClosingPosition = false; // Cờ để tránh gửi nhiều lệnh đóng cùng lúc
let botRunning = false; // Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botStartTime = null; // Thời điểm bot được khởi động

// --- BIẾN TRẠNG THÁI VỊ THẾ MỚI (HEDGING) ---
let currentLongPosition = null;
let currentShortPosition = null;

// Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
let positionCheckInterval = null;
let nextScheduledCycleTimeout = null; // Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (runTradingLogic)
let retryBotTimeout = null; // Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
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
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DUC (GIÁ TRỊ MẶC ĐỊNH) ---
let INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 1 USDT
let TARGET_COIN_SYMBOL = 'ETHUSDT'; // Mặc định ETHUSDT

// Biến để lưu trữ tổng lời/lỗ
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

// --- BIẾN TRẠNG THÁI WEBSOCKET ---
let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null; // Cache giá từ WebSocket

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1230;
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${process.env.name || 'home'}-out.log`;
const THIS_BOT_PM2_NAME = process.env.name || 'home';

// --- LOGGING TO FILE ---
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log');
const LOG_TO_CUSTOM_FILE = true;

// --- HÀM TIỆN ÍCH ---
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
                console.log(`[${time}](Lặp lại x${logCounts[messageHash].count}) ${message}`);
                if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, `[${time}](Lặp lại x${logCounts[messageHash].count}) ${message}\n`, (err) => {
                        if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
                    });
                }
            } else {
                console.log(logEntry);
                if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {
                        if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
                    });
                }
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        console.log(logEntry);
        if (LOG_TO_CUSTOM_FILE) {
            fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {
                if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
            });
        }
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
}

function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            path: path,
            method: method,
            headers: headers,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`;
                    }
                    addLog(`HTTP Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`Network lỗi: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new CriticalApiError("❌ Missing Binance API_KEY hoặc API_SECRET. Vui lòng kiểm tra file config.js.");
    }
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;

    let queryString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath;
    let requestBody = '';
    const headers = {
        'X-MBX-APIKEY': API_KEY,
    };

    if (method === 'GET') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (method === 'PUT') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -2015) {
            addLog("  -> Kiểm tra API Key/Secret và quyền Futures.");
        } else if (error.code === -1021) {
            addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính.");
        } else if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API!");
        } else if (error.code === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số.");
        } else if (error.code === -4061) {
            addLog("  -> Lỗi -4061 (Order's position side does not match user's setting). Đảm bảo đã bật Hedge Mode và lệnh có positionSide phù hợp.");
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error;
    }
}

async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');
    const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API!");
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error;
    }
}

async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
        addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`);
    } catch (error) {
        addLog(`Lỗi đồng bộ thời gian: ${error.message}.`);
        serverTimeOffset = 0;
        throw error;
    }
}

async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });
        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);
            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                const firstBracket = symbolData.brackets[0];
                return parseInt(firstBracket.maxInitialLeverage || firstBracket.initialLeverage);
            }
        }
        addLog(`Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

async function setLeverage(symbol, leverage) {
    try {
        addLog(`Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        });
        addLog(`Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        return true;
    } catch (error) {
        addLog(`Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${error.msg || error.message}`);
        if (error.code === -4046 || error.code === -4048) {
             addLog(`Đòn bẩy ${leverage}x không hợp lệ cho ${symbol}.`);
             return false;
        }
        return false;
    }
}

async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    addLog('Lấy exchangeInfo...');
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        addLog(`Đã nhận exchangeInfo. Symbols: ${data.symbols.length}`);

        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0.001),
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
            };
        });
        addLog('Đã tải thông tin sàn.');
        return exchangeInfoCache;
    } catch (error) {
        addLog('Lỗi lấy exchangeInfo: ' + (error.msg || error.message));
        exchangeInfoCache = null;
        throw error;
    }
}

async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        addLog(`Không tìm thấy filters cho ${symbol}.`);
        return null;
    }
    return filters[symbol];
}

async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        const price = parseFloat(data.price);
        return price;
    } catch (error) {
        addLog(`Lỗi lấy giá hiện tại cho ${symbol} từ REST API: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
             addLog(`Lỗi nghiêm trọng khi lấy giá cho ${symbol}: ${error.msg || error.message}`);
        }
        return null;
    }
}

async function cancelOpenOrdersForSymbol(symbol, orderId = null, positionSide = null) {
    try {
        let params = { symbol: symbol };
        if (orderId) {
            params.orderId = orderId;
        }
        if (positionSide) {
             params.positionSide = positionSide;
        }

        if (orderId) {
            addLog(`Đang hủy lệnh ${orderId} cho ${symbol} (positionSide: ${positionSide || 'Tất cả'}).`);
            await callSignedAPI('/fapi/v1/order', 'DELETE', params);
            addLog(`Đã hủy lệnh ${orderId} cho ${symbol}.`);
        } else {
            addLog(`Đang hủy tất cả lệnh chờ cho ${symbol} (positionSide: ${positionSide || 'Tất cả'}).`);
            await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', params);
            addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
        }
    } catch (error) {
        addLog(`Lỗi hủy lệnh chờ cho ${symbol} (OrderId: ${orderId || 'TẤT CẢ'}, positionSide: ${positionSide || 'TẤT CẢ'}): ${error.msg || error.message}`);
        if (error.code === -2011) {
            addLog(`Không có lệnh chờ nào để hủy cho ${symbol}.`);
        } else if (error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi hủy lệnh.`);
             stopBotLogicInternal();
        }
    }
}

async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnl, S: orderSide, q: orderQuantity, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;

    if (symbol !== TARGET_COIN_SYMBOL) {
        addLog(`Bỏ qua xử lý kết quả giao dịch cho ${symbol}. Chỉ xử lý cho ${TARGET_COIN_SYMBOL}.`);
        return;
    }

    if (orderStatus !== 'FILLED' || parseFloat(realizedPnl) === 0) {
        return;
    }

    let isFullClosureOrder = false;
    if (currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId)) {
        addLog(`Lệnh LONG khớp TP/SL hoàn toàn.`);
        isFullClosureOrder = true;
    } else if (currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId)) {
        addLog(`Lệnh SHORT khớp TP/SL hoàn toàn.`);
        isFullClosureOrder = true;
    }

    addLog(`Đang xử lý kết quả giao dịch ${symbol} (PositionSide: ${positionSide}) với PNL: ${parseFloat(realizedPnl).toFixed(4)}`);

    if (parseFloat(realizedPnl) > 0.000001) {
        totalProfit += parseFloat(realizedPnl);
    } else if (parseFloat(realizedPnl) < -0.000001) {
        totalLoss += Math.abs(parseFloat(realizedPnl));
    }
    netPNL = totalProfit - totalLoss;

    addLog([
        `🔴 Đã đóng ${positionSide} ${symbol}`,
        `├─ PNL: ${parseFloat(realizedPnl).toFixed(2)} USDT`,
        `├─ Tổng Lời: ${totalProfit.toFixed(2)} USDT`,
        `├─ Tổng Lỗ: ${totalLoss.toFixed(2)} USDT`,
        `└─ PNL Ròng: ${netPNL.toFixed(2)} USDT`
    ].join('\n'));

    if (isFullClosureOrder) {
        addLog(`Lệnh TP/SL chính cho ${symbol} (${positionSide}) đã khớp. Đang đóng vị thế còn lại.`);
        let closedPosition = null;
        let remainingPosition = null;

        if (positionSide === 'LONG') {
            closedPosition = currentLongPosition;
            remainingPosition = currentShortPosition;
            currentLongPosition = null;
        } else if (positionSide === 'SHORT') {
            closedPosition = currentShortPosition;
            remainingPosition = currentLongPosition;
            currentShortPosition = null;
        }

        if (remainingPosition && Math.abs(remainingPosition.quantity) > 0) {
            addLog(`Đang đóng lệnh ${remainingPosition.side} (${symbol}) còn lại.`);
            await closePosition(remainingPosition.symbol, Math.abs(remainingPosition.quantity), `Đóng lệnh ${positionSide} khớp TP/SL`, remainingPosition.side);
        } else {
             addLog(`Không tìm thấy lệnh đối ứng còn lại để đóng hoặc đã đóng rồi.`);
        }

        if (positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol, null, 'BOTH');
        await checkAndHandleRemainingPosition(symbol);

        if(botRunning) scheduleNextMainCycle();
    } else {
        addLog(`Lệnh ${orderId} có PNL nhưng không phải lệnh TP/SL chính. Giả định là đóng từng phần. Không reset chu kỳ bot.`);
    }
}

async function closePosition(symbol, quantity, reason, positionSide) {
    if (symbol !== TARGET_COIN_SYMBOL) {
        addLog(`Bỏ qua đóng vị thế cho ${symbol}. Chỉ đóng cho ${TARGET_COIN_SYMBOL}.`);
        return;
    }

    if (!positionSide || (positionSide !== 'LONG' && positionSide !== 'SHORT')) {
        addLog(`Lỗi: closePosition yêu cầu positionSide (LONG/SHORT) rõ ràng trong Hedge Mode. Lý do: ${reason}.`);
        return;
    }

    if (isClosingPosition) {
        return;
    }
    isClosingPosition = true;

    addLog(`Đang chuẩn bị đóng lệnh ${positionSide} ${symbol} (Lý do: ${reason}).`);

    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`);
            isClosingPosition = false;
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} (PositionSide: ${positionSide}) đã đóng trên sàn hoặc không có vị thế để đóng. Lý do: ${reason}.`);
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';

            if (adjustedActualQuantity <= 0) {
                addLog(`Số lượng đóng (${adjustedActualQuantity}) cho ${symbol} (PositionSide: ${positionSide}) không hợp lệ. Không gửi lệnh đóng.`);
                isClosingPosition = false;
                return;
            }

            addLog(`Gửi lệnh đóng: ${symbol}, Side: ${closeSide}, PositionSide: ${positionSide}, Type: MARKET, Qty: ${adjustedActualQuantity}`);

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                positionSide: positionSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
            });

            addLog(`Đã gửi lệnh đóng ${closeSide} ${symbol} (PositionSide: ${positionSide}). Lý do: ${reason}.`);
            await sleep(1000);
        }

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol} (PositionSide: ${positionSide}): ${error.msg || error.message}`);
        if (error.code === -2011) {
            addLog(`Lỗi -2011 khi đóng vị thế ${symbol} (PositionSide: ${positionSide}), có thể vị thế đã đóng. Kiểm tra lại.`);
            await checkAndHandleRemainingPosition(symbol);
        }
        else if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi cố gắng đóng vị thế.`);
            stopBotLogicInternal();
        }
    } finally {
        isClosingPosition = false;
    }
}

async function closePartialPosition(position, percentageOfInitialQuantity, type = 'PROFIT') {
    if (position.initialQuantity === undefined || position.initialQuantity <= 0) {
        addLog(`Lỗi: Không có khối lượng ban đầu hợp lệ (initialQuantity) cho lệnh ${position.side} ${position.symbol}. Không thể đóng từng phần.`);
        return;
    }

    addLog(`Đang đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh ${position.side} ${position.symbol} (type: ${type === 'PROFIT' ? 'lãi' : 'lỗ'}).`);

    try {
        const symbolInfo = await getSymbolDetails(position.symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${position.symbol}. Không đóng từng phần.`);
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;

        let quantityToClose = position.initialQuantity * (percentageOfInitialQuantity / 100);

        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || Math.abs(parseFloat(currentPositionOnBinance.positionAmt)) === 0) {
            addLog(`Vị thế ${position.side} ${position.symbol} đã đóng trên sàn hoặc không tồn tại. Không thể đóng từng phần.`);
            return;
        }

        const actualPositionQuantity = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));

        const roundToStepSize = (qty, step) => {
            return Math.floor(qty / step) * step;
        };

        quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
        quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));

        const MIN_PARTIAL_CLOSE_VALUE_USDT = 0.003;

        if (quantityToClose <= 0) {
            addLog(`Số lượng đóng từng phần (${quantityToClose.toFixed(quantityPrecision)}) quá nhỏ hoặc bằng 0 cho ${position.symbol}.`);
            return;
        }

        const currentPrice = position.currentPrice; 
        if (!currentPrice || currentPrice <= 0) {
             addLog(`Không có giá hiện tại hợp lệ cho ${position.symbol}. Không thể đóng từng phần.`);
             return;
        }

        if (quantityToClose * currentPrice < MIN_PARTIAL_CLOSE_VALUE_USDT) {
            addLog(`Giá trị lệnh đóng từng phần nhỏ hơn ${MIN_PARTIAL_CLOSE_VALUE_USDT} USDT. Không đóng để tránh lỗi làm tròn/notional.`);
            return;
        }

        if (quantityToClose > actualPositionQuantity) {
            addLog(`Cảnh báo: Số lượng tính toán để đóng từng phần (${quantityToClose.toFixed(quantityPrecision)}) lớn hơn số lượng vị thế hiện tại (${actualPositionQuantity.toFixed(quantityPrecision)}). Điều chỉnh để đóng tối đa số lượng còn lại.`);
            quantityToClose = actualPositionQuantity;
            quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
            quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));
        }

        if (quantityToClose <= 0) {
            addLog(`Sau khi kiểm tra, số lượng đóng từng phần vẫn là 0 hoặc không hợp lệ. Hủy đóng.`);
            return;
        }

        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

        addLog(`Gửi lệnh đóng từng phần: ${position.symbol}, Side: ${closeSide}, PositionSide: ${position.side}, Type: MARKET, Qty: ${quantityToClose}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: closeSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToClose,
        });

        addLog(`Đã gửi lệnh đóng từng phần ${closeSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);

        const usdtAmountClosed = quantityToClose * currentPrice;

        if (type === 'PROFIT') {
            position.closedAmount += usdtAmountClosed; 
        } else { 
            position.closedLossAmount += usdtAmountClosed; 
        }

        addLog(`Đã gửi lệnh đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh ${position.side}.`);
        addLog(`Tổng vốn (USDT) đã đóng từ lãi: ${position.closedAmount.toFixed(2)} USDT.`);
        addLog(`Tổng vốn (USDT) đã đóng từ lỗ: ${position.closedLossAmount.toFixed(2)} USDT.`);

        await sleep(1000); 

    } catch (error) {
        addLog(`Lỗi khi đóng từng phần lệnh ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error.code === -2011) {
            addLog(`Lỗi -2011 khi đóng từng phần ${position.side} ${position.symbol}, có thể vị thế đã đóng hoàn toàn.`);
        }
        else if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi đóng từng phần.`);
            stopBotLogicInternal();
        }
    }
}

async function addPosition(position, amountToReopen, type = 'PROFIT') {
    if (amountToReopen <= 0) {
        addLog(`Không có số vốn để mở thêm cho lệnh ${position.side} ${position.symbol}.`);
        return;
    }

    addLog(`Đang mở thêm ${amountToReopen.toFixed(2)} USDT cho lệnh ${position.side} ${position.symbol} (type: ${type === 'PROFIT' ? 'bù lãi đã chốt' : 'bù lỗ đã cắt'}).`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không mở thêm lệnh.`);
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;
        const currentPrice = await getCurrentPrice(position.symbol);
        if (!currentPrice) {
            addLog(`Không có giá hiện tại hợp lệ cho ${position.symbol}. Không thể mở thêm.`);
            return;
        }

        const maxLeverage = position.maxLeverageUsed;
        if (!maxLeverage) {
            addLog(`Không thể lấy đòn bẩy đã sử dụng cho ${position.symbol}.`);
            return;
        }

        let quantityToAdd = (amountToReopen * maxLeverage) / currentPrice;
        quantityToAdd = Math.floor(quantityToAdd / stepSize) * stepSize;
        quantityToAdd = parseFloat(quantityToAdd.toFixed(quantityPrecision));

        if (quantityToAdd <= 0 || quantityToAdd * currentPrice < minNotional) {
            addLog(`Số lượng hoặc giá trị lệnh mở thêm quá nhỏ (${quantityToAdd.toFixed(quantityPrecision)} Qty, Notional: ${quantityToAdd * currentPrice}). Hủy.`);
            return;
        }

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: quantityToAdd,
            newOrderRespType: 'FULL'
        });

        addLog(`Đã gửi lệnh MARKET để mở thêm ${orderSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000);

        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const updatedPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (updatedPositionOnBinance) {
            const oldTotalCost = position.entryPrice * position.quantity;
            const newTotalCost = parseFloat(updatedPositionOnBinance.entryPrice) * Math.abs(parseFloat(updatedPositionOnBinance.positionAmt));
            const newTotalQuantity = Math.abs(parseFloat(updatedPositionOnBinance.positionAmt));
            const newEntryPrice = newTotalCost / newTotalQuantity;

            position.entryPrice = newEntryPrice;
            position.quantity = newTotalQuantity;

            addLog(`Đã mở thêm thành công cho ${position.side} ${position.symbol}. Số lượng mới: ${position.quantity.toFixed(quantityPrecision)}, Giá vào trung bình mới: ${newEntryPrice.toFixed(pricePrecision)}.`);

            if (type === 'PROFIT') {
                position.closedAmount = 0;
                position.nextPartialCloseIndex = 0; 
            } else { 
                position.closedLossAmount = 0;
                position.nextPartialCloseLossIndex = 0; 
            }
            
            position.hasAdjustedSLTo200PercentProfit = false; 
            position.hasAdjustedSLTo500PercentProfit = false; 

            await updateTPandSLForTotalPosition(position, maxLeverage);

        } else {
            addLog(`Không tìm thấy vị thế ${position.side} ${position.symbol} sau khi mở thêm. Lỗi đồng bộ.`);
        }

    } catch (error) {
        addLog(`Lỗi khi mở thêm lệnh cho ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở thêm lệnh.`);
            stopBotLogicInternal();
        }
    }
}

// --- KHỞI TẠO WEB SERVER VÀ CÁC API ENDPOINT ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, customLogData) => {
        if (!err && customLogData && customLogData.trim().length > 0) {
            const cleanData = customLogData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
            const lines = cleanData.split('\n');
            const maxDisplayLines = 500;
            const startIndex = Math.max(0, lines.length - maxDisplayLines);
            const limitedLogs = lines.slice(startIndex).join('\n');
            res.send(limitedLogs);
        } else {
            fs.readFile(BOT_LOG_FILE, 'utf8', (err, pm2LogData) => {
                if (err) {
                    console.error('Lỗi đọc log file:', err);
                    if (err.code === 'ENOENT') {
                        return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}. Đảm bảo PM2 đang chạy và tên log chính xác.`);
                    }
                    return res.status(500).send('Lỗi đọc log file');
                }
                const cleanData = pm2LogData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
                const lines = cleanData.split('\n');
                const maxDisplayLines = 500;
                const startIndex = Math.max(0, lines.length - maxDisplayLines);
                const limitedLogs = lines.slice(startIndex).join('\n');
                res.send(limitedLogs);
            });
        }
    });
});

app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => {
            exec('pm2 jlist', (error, stdout, stderr) => {
                if (error) reject(stderr || error.message);
                resolve(stdout);
            });
        });
        const processes = JSON.parse(pm2List);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME);

        let statusMessage = 'MAY CHU: DA TAT (PM2)';
        if (botProcess) {
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI BOT: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                }
                statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL}`;
                statusMessage += ` | Vốn lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME}). Đảm bảo đã chạy PM2!`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`);
    }
});

app.get('/api/bot_stats', async (req, res) => {
    try {
        let openPositionsData = [];
        if (currentLongPosition && currentLongPosition.symbol === TARGET_COIN_SYMBOL) {
            openPositionsData.push({
                symbol: currentLongPosition.symbol,
                side: currentLongPosition.side,
                quantity: currentLongPosition.quantity,
                initialQuantity: currentLongPosition.initialQuantity,
                entryPrice: currentLongPosition.entryPrice,
                currentPrice: currentLongPosition.currentPrice || 0,
                unrealizedPnl: currentLongPosition.unrealizedPnl || 0,
                pricePrecision: currentLongPosition.pricePrecision,
                TPId: currentLongPosition.currentTPId,
                SLId: currentLongPosition.currentSLId,
                initialMargin: currentLongPosition.initialMargin,
                closedAmount: currentLongPosition.closedAmount,
                partialCloseLevels: currentLongPosition.partialCloseLevels,
                nextPartialCloseIndex: currentLongPosition.nextPartialCloseIndex,
                closedLossAmount: currentLongPosition.closedLossAmount,
                partialCloseLossLevels: currentLongPosition.partialCloseLossLevels,
                nextPartialCloseLossIndex: currentLongPosition.nextPartialCloseLossIndex,
                hasAdjustedSLTo200PercentProfit: currentLongPosition.hasAdjustedSLTo200PercentProfit,
                hasAdjustedSLTo500PercentProfit: currentLongPosition.hasAdjustedSLTo500PercentProfit,
            });
        }
        if (currentShortPosition && currentShortPosition.symbol === TARGET_COIN_SYMBOL) {
            openPositionsData.push({
                symbol: currentShortPosition.symbol,
                side: currentShortPosition.side,
                quantity: currentShortPosition.quantity,
                initialQuantity: currentShortPosition.initialQuantity,
                entryPrice: currentShortPosition.entryPrice,
                currentPrice: currentShortPosition.currentPrice || 0,
                unrealizedPnl: currentShortPosition.unrealizedPnl || 0,
                pricePrecision: currentShortPosition.pricePrecision,
                TPId: currentShortPosition.currentTPId,
                SLId: currentShortPosition.currentSLId,
                initialMargin: currentShortPosition.initialMargin,
                closedAmount: currentShortPosition.closedAmount,
                partialCloseLevels: currentShortPosition.partialCloseLevels,
                nextPartialCloseIndex: currentShortPosition.nextPartialCloseIndex,
                closedLossAmount: currentShortPosition.closedLossAmount,
                partialCloseLossLevels: currentShortPosition.partialCloseLossLevels,
                nextPartialCloseLossIndex: currentShortPosition.nextPartialCloseLossIndex,
                hasAdjustedSLTo200PercentProfit: currentShortPosition.hasAdjustedSLTo200PercentProfit,
                hasAdjustedSLTo500PercentProfit: currentShortPosition.hasAdjustedSLTo500PercentProfit,
            });
        }

        res.json({
            success: true,
            data: {
                totalProfit: totalProfit,
                totalLoss: totalLoss,
                netPNL: netPNL,
                currentOpenPositions: openPositionsData,
                currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT,
            }
        });
    } catch (error) {
        console.error('Lỗi khi lấy thống kê bot:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy thống kê bot.' });
    }
});

app.post('/api/configure', (req, res) => {
    const { coinConfigs } = req.body;

    if (coinConfigs && coinConfigs.length > 0) {
        const config = coinConfigs[0];
        const oldTargetCoinSymbol = TARGET_COIN_SYMBOL;
        TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase();
        INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);

        if (oldTargetCoinSymbol !== TARGET_COIN_SYMBOL) {
            addLog(`Đồng coin mục tiêu đã thay đổi từ ${oldTargetCoinSymbol} sang ${TARGET_COIN_SYMBOL}. Reset trạng thái giao dịch.`);
            currentLongPosition = null;
            currentShortPosition = null;
            totalProfit = 0;
            totalLoss = 0;
            netPNL = 0;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            if (botRunning) {
                setupMarketDataStream(TARGET_COIN_SYMBOL);
            }
        }
    } else {
        addLog("Cảnh báo: Không có cấu hình đồng coin nào được gửi.");
    }

    addLog(`Đã cập nhật cấu hình:`);
    addLog(`  API Key: Đã thiết lập từ file config.js`);
    addLog(`  Secret Key: Đã thiết lập từ file config.js`);
    addLog(`  Đồng coin: ${TARGET_COIN_SYMBOL}`);
    addLog(`  Số vốn ban đầu (mỗi lệnh): ${INITIAL_INVESTMENT_AMOUNT} USDT`);

    res.json({ success: true, message: 'Cấu hình đã được cập nhật.' });
});

app.get('/start_bot_logic', async (req, res) => {
    const message = await startBotLogicInternal();
    res.send(message);
});

app.get('/stop_bot_logic', (req, res) => {
    const message = stopBotLogicInternal();
    res.send(message);
});

app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`);
    addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`);
});
