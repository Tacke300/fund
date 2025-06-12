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

// Biến cache cho exchangeInfo để tránh gọi API lặp lại
let exchangeInfoCache = null;

// Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc
let isClosingPosition = false;

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// --- START: BIẾN TRẠNG THÁI VỊ THẾ MỚI (HEDGING) ---
// Thêm trường `closedAmount` và `partialCloseLevels`
// Thêm `maxLeverageUsed` để không cần gọi API nhiều lần để lấy đòn bẩy
// `positionSide` sẽ là 'LONG' hoặc 'SHORT'
// Thêm `partialCloseLossLevels` để theo dõi các mốc đóng lệnh lỗ
// Thêm `nextPartialCloseLossIndex` để theo dõi mốc đóng lệnh lỗ tiếp theo
// THÊM initialQuantity ĐỂ LƯU TRỮ KHỐI LƯỢNG BAN ĐẦU
let currentLongPosition = null; // { symbol, quantity, entryPrice, initialTPPrice, initialSLPrice, initialMargin, openTime, pricePrecision, side, currentPrice, unrealizedPnl, currentTPId, currentSLId, closedAmount, partialCloseLevels, nextPartialCloseIndex, hasAdjustedSLTo200PercentProfit, hasAdjustedSLTo500PercentProfit, maxLeverageUsed, closedLossAmount, partialCloseLossLevels, nextPartialCloseLossIndex, initialQuantity }
let currentShortPosition = null; // Tương tự như trên

// Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
let positionCheckInterval = null;
// Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (runTradingLogic)
let nextScheduledCycleTimeout = null;
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null;

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
let INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 1 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'ETHUSDT'; // Mặc định ETHUSDT (sẽ được cập nhật từ UI)

// Biến để lưu trữ tổng lời/lỗ
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

// --- BIẾN TRẠẠNG THÁI WEBSOCKET ---
let marketWs = null;
let userDataWs = null;
let listenKey = null;
let listenKeyRefreshInterval = null;
let currentMarketPrice = null; // Cache giá từ WebSocket

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1111;
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${process.env.name || 'test'}-out.log`;
const THIS_BOT_PM2_NAME = process.env.name || 'test';

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
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
                 if (LOG_TO_CUSTOM_FILE) {
                    fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}\n`, (err) => {
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

// Chỉnh sửa hàm callSignedAPI để chấp nhận positionSide
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        // Log này trước đây chỉ kiểm tra process.env, gây nhầm lẫn. Đã chỉnh sửa để sử dụng API_KEY đã import.
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
    }
    else if (method === 'DELETE') {
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
    // Không gọi getLeverageBracketForSymbol ở đây nữa, sẽ lấy từ currentPosition.maxLeverageUsed
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

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {string} [orderId] - Tùy chọn: chỉ hủy lệnh với orderId cụ thể.
 * @param {string} [positionSide] - THÊM: 'LONG' hoặc 'SHORT' để hủy lệnh theo positionSide.
 */
async function cancelOpenOrdersForSymbol(symbol, orderId = null, positionSide = null) {
    try {
        let params = { symbol: symbol };
        if (orderId) {
            params.orderId = orderId;
        }
        // Thêm positionSide vào tham số khi hủy lệnh nếu được cung cấp
        // API Binance cho phép hủy lệnh theo positionSide (ví dụ: allOpenOrders)
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

/**
 * Hàm xử lý kết quả giao dịch và điều chỉnh vốn.
 * Hàm này sẽ được gọi khi User Data Stream báo cáo realizedPnl.
 * @param {object} orderInfo - Thông tin lệnh từ ORDER_TRADE_UPDATE.
 */
async function processTradeResult(orderInfo) {
    const { s: symbol, rp: realizedPnl, S: orderSide, q: orderQuantity, X: orderStatus, i: orderId, ps: positionSide } = orderInfo;

    // Đảm bảo chỉ xử lý cho đồng coin mà bot đang theo dõi
    if (symbol !== TARGET_COIN_SYMBOL) {
        addLog(`Bỏ qua xử lý kết quả giao dịch cho ${symbol}. Chỉ xử lý cho ${TARGET_COIN_SYMBOL}.`);
        return;
    }

    // Chỉ xử lý khi lệnh đã khớp hoàn toàn (FILLED) và có PNL thực tế khác 0
    if (orderStatus !== 'FILLED' || parseFloat(realizedPnl) === 0) {
        return;
    }

    // Nếu đây là một lệnh đóng từng phần, PNL thường là một phần của tổng PNL
    // Chúng ta sẽ xử lý PNL thực tế cho tổng PNL và không kích hoạt reset chu kỳ
    // nếu nó là lệnh đóng từng phần.
    // Lệnh TP/SL (STOP_MARKET/TAKE_PROFIT_MARKET) ban đầu luôn đóng toàn bộ vị thế.
    // Phân biệt: lệnh đóng toàn bộ vị thế sẽ có `realizedPnl` khác 0 và không phải `reduceOnly`.
    // Binance không cung cấp `reduceOnly` trong `ORDER_TRADE_UPDATE`.
    // Thay vào đó, chúng ta sẽ dựa vào việc kiểm tra liệu lệnh này có phải là SL/TP ban đầu của bot không.
    let isFullClosureOrder = false;
    if (currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId)) {
        addLog(`Lệnh LONG khớp TP/SL hoàn toàn.`);
        isFullClosureOrder = true;
    } else if (currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId)) {
        addLog(`Lệnh SHORT khớp TP/SL hoàn toàn.`);
        isFullClosureOrder = true;
    }

    addLog(`Đang xử lý kết quả giao dịch ${symbol} (PositionSide: ${positionSide}) với PNL: ${parseFloat(realizedPnl).toFixed(4)}`);

    // Cập nhật tổng lời/lỗ
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

    // Sửa đổi 3: Khi có 1 vị thế bị đóng hoàn toàn với bất kỳ lý do gì => đóng nốt vị thế còn lại để chạy chu kỳ mới.
    // Logic này sẽ được gọi nếu lệnh khớp là lệnh TP/SL chính (isFullClosureOrder)
    // hoặc nếu chúng ta phát hiện một vị thế bị đóng hoàn toàn trong `manageOpenPosition`
    // và kích hoạt `checkAndHandleRemainingPosition`
    if (isFullClosureOrder) {
        addLog(`Lệnh TP/SL chính cho ${symbol} (${positionSide}) đã khớp. Đang đóng vị thế còn lại.`);
        // Đảm bảo lệnh đối ứng đã đóng hoàn toàn
        let closedPosition = null;
        let remainingPosition = null;

        if (positionSide === 'LONG') {
            closedPosition = currentLongPosition;
            remainingPosition = currentShortPosition;
            currentLongPosition = null; // Đặt về null ngay để thể hiện đã đóng
        } else if (positionSide === 'SHORT') {
            closedPosition = currentShortPosition;
            remainingPosition = currentLongPosition;
            currentShortPosition = null; // Đặt về null ngay để thể hiện đã đóng
        }

        // Đảm bảo vị thế đối ứng được đóng nếu còn tồn tại
        if (remainingPosition && Math.abs(remainingPosition.quantity) > 0) {
            addLog(`Đang đóng lệnh ${remainingPosition.side} (${symbol}) còn lại.`);
            // Gọi closePosition với positionSide rõ ràng
            await closePosition(remainingPosition.symbol, Math.abs(remainingPosition.quantity), `Đóng lệnh ${positionSide} khớp TP/SL`, remainingPosition.side);
        } else {
             addLog(`Không tìm thấy lệnh đối ứng còn lại để đóng hoặc đã đóng rồi.`);
        }

        // Dọn dẹp trạng thái bot sau khi một chu kỳ giao dịch hoàn tất
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); // Hủy các lệnh chờ cũ cho cả LONG và SHORT
        await checkAndHandleRemainingPosition(symbol); // Đảm bảo không còn vị thế sót

        // Kích hoạt chu kỳ chính để mở lệnh mới
        if(botRunning) scheduleNextMainCycle();
    } else {
        addLog(`Lệnh ${orderId} có PNL nhưng không phải lệnh TP/SL chính. Giả định là đóng từng phần. Không reset chu kỳ bot.`);
    }
}

/**
 * Hàm đóng vị thế hiện tại và xử lý logic sau khi đóng.
 * Cần chỉ định rõ positionSide để đóng lệnh trong Hedge Mode.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng của vị thế cần đóng.
 * @param {string} reason - Lý do đóng vị thế (ví dụ: "TP khớp", "SL khớp", "Thủ công", "Vị thế sót").
 * @param {string} positionSide - BẮT BUỘC: 'LONG' hoặc 'SHORT' để đóng một side cụ thể.
 */
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
        // addLog(`Đang trong quá trình đóng vị thế ${symbol}. Bỏ qua yêu cầu đóng mới.`); // Giảm bớt log này
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
            // side của lệnh đóng sẽ ngược với positionSide
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
                positionSide: positionSide, // THÊM positionSide
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                // reduceOnly: 'true' // KHÔNG DÙNG reduceOnly trong Hedge Mode cho lệnh market. Thay vào đó dùng side/positionSide
            });

            addLog(`Đã gửi lệnh đóng ${closeSide} ${symbol} (PositionSide: ${positionSide}). Lý do: ${reason}.`);
            await sleep(1000); // Đợi lệnh khớp
        }

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol} (PositionSide: ${positionSide}): ${error.msg || error.message}`);
        if (error.code === -2011) { // Lỗi không tìm thấy lệnh
            addLog(`Lỗi -2011 khi đóng vị thế ${symbol} (PositionSide: ${positionSide}), có thể vị thế đã đóng. Kiểm tra lại.`);
            await checkAndHandleRemainingPosition(symbol); // Thử kiểm tra và xử lý lại
        }
        else if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi cố gắng đóng vị thế.`);
            stopBotLogicInternal();
        }
    } finally {
        isClosingPosition = false;
    }
}

/**
 * Hàm đóng từng phần vị thế khi đạt mốc lãi hoặc lỗ.
 * Cần chỉ định rõ positionSide để đóng lệnh trong Hedge Mode.
 * @param {object} position - Vị thế cần đóng từng phần.
 * @param {number} percentageOfInitialQuantity - Tỷ lệ phần trăm khối lượng ban đầu để đóng (ví dụ: 10).
 * @param {string} type - 'PROFIT' hoặc 'LOSS'.
 */
async function closePartialPosition(position, percentageOfInitialQuantity, type = 'PROFIT') {
    // THAY ĐỔI LOGIC TÍNH TOÁN: 10% của khối lượng ban đầu
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

        // Sửa đổi 1: đoạn đóng lệnh 1 phần là chỉ đóng 1 phần lệnh đang lỗ. K phải đóng cả 2
        // Logic đã được điều chỉnh. Hàm này sẽ chỉ đóng "một phần lệnh đang lỗ" nếu `position` truyền vào là lệnh lỗ.
        // `percentageOfInitialQuantity` sẽ áp dụng cho `position.initialQuantity` của chính lệnh đó.
        let quantityToClose = position.initialQuantity * (percentageOfInitialQuantity / 100);

        // Lấy thông tin vị thế thực tế trên sàn để đảm bảo số lượng hiện tại
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || Math.abs(parseFloat(currentPositionOnBinance.positionAmt)) === 0) {
            addLog(`Vị thế ${position.side} ${position.symbol} đã đóng trên sàn hoặc không tồn tại. Không thể đóng từng phần.`);
            return;
        }
        // Sử dụng số lượng thực tế của vị thế hiện tại để tính toán chính xác hơn
        const actualPositionQuantity = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));

        // Làm tròn số lượng theo stepSize của sàn
        const roundToStepSize = (qty, step) => {
            return Math.floor(qty / step) * step;
        };

        quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
        quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));

        // Giá trị tối thiểu cho lệnh đóng từng phần (Binance thường cho phép reduceOnly nhỏ)
        // Đây là ngưỡng an toàn để tránh lỗi "notional too low"
        const MIN_PARTIAL_CLOSE_VALUE_USDT = 0.003; // Bạn có thể tùy chỉnh nếu cần

        // Kiểm tra minNotional và số lượng tối thiểu có thể đóng
        if (quantityToClose <= 0) {
            addLog(`Số lượng đóng từng phần (${quantityToClose.toFixed(quantityPrecision)}) quá nhỏ hoặc bằng 0 cho ${position.symbol}.`);
            return;
        }

        // Kiểm tra lại currentPrice để tính notional
        const currentPrice = position.currentPrice; // Lấy giá hiện tại từ cached position
        if (!currentPrice || currentPrice <= 0) {
             addLog(`Không có giá hiện tại hợp lệ cho ${position.symbol}. Không thể đóng từng phần.`);
             return;
        }

        if (quantityToClose * currentPrice < MIN_PARTIAL_CLOSE_VALUE_USDT) {
            addLog(`Giá trị lệnh đóng từng phần (${(quantityToClose * currentPrice).toFixed(8)} USDT) nhỏ hơn ${MIN_PARTIAL_CLOSE_VALUE_USDT} USDT. Không đóng để tránh lỗi làm tròn/notional.`);
            return;
        }

        // Đảm bảo số lượng cần đóng không vượt quá số lượng vị thế hiện tại
        if (quantityToClose > actualPositionQuantity) {
            addLog(`Cảnh báo: Số lượng tính toán để đóng từng phần (${quantityToClose.toFixed(quantityPrecision)}) lớn hơn số lượng vị thế hiện tại (${actualPositionQuantity.toFixed(quantityPrecision)}). Điều chỉnh để đóng tối đa số lượng còn lại.`);
            quantityToClose = actualPositionQuantity;
            // Làm tròn lại lần nữa sau khi điều chỉnh
            quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
            quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));
        }

        if (quantityToClose <= 0) {
            addLog(`Sau khi kiểm tra, số lượng đóng từng phần vẫn là 0 hoặc không hợp lệ. Hủy đóng.`);
            return;
        }

        // side của lệnh đóng sẽ ngược với positionSide của vị thế
        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

        addLog(`Gửi lệnh đóng từng phần: ${position.symbol}, Side: ${closeSide}, PositionSide: ${position.side}, Type: MARKET, Qty: ${quantityToClose}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: closeSide,
            positionSide: position.side, // THÊM positionSide
            type: 'MARKET',
            quantity: quantityToClose,
            // reduceOnly: 'true' // KHÔNG DÙNG reduceOnly trong Hedge Mode cho lệnh market.
        });

        addLog(`Đã gửi lệnh đóng từng phần ${closeSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);

        // Cập nhật trạng thái của vị thế (chỉ trong bộ nhớ, không phải trên sàn ngay lập tức)
        // Việc này sẽ được đồng bộ lại bởi manageOpenPosition sau này khi nó lấy lại thông tin vị thế
        // Nhưng chúng ta vẫn cập nhật tạm thời để logic tiếp theo không bị lỗi
        // position.quantity -= quantityToClose; // Giảm số lượng vị thế hiện tại (bỏ qua vì manageOpenPosition sẽ làm)

        // Tính toán số USDT tương ứng với khối lượng đã đóng
        const usdtAmountClosed = quantityToClose * currentPrice;

        if (type === 'PROFIT') {
            position.closedAmount += usdtAmountClosed; // Tăng tổng vốn (USDT) đã đóng từ lãi
        } else { // type === 'LOSS'
            position.closedLossAmount += usdtAmountClosed; // Tăng tổng vốn (USDT) đã đóng từ lỗ
        }


        addLog(`Đã gửi lệnh đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh ${position.side}.`);
        addLog(`Tổng vốn (USDT) đã đóng từ lãi: ${position.closedAmount.toFixed(2)} USDT.`);
        addLog(`Tổng vốn (USDT) đã đóng từ lỗ: ${position.closedLossAmount.toFixed(2)} USDT.`);


        await sleep(1000); // Đợi lệnh khớp

    } catch (error) {
        addLog(`Lỗi khi đóng từng phần lệnh ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error.code === -2011) { // Lỗi không tìm thấy lệnh
            addLog(`Lỗi -2011 khi đóng từng phần ${position.side} ${position.symbol}, có thể vị thế đã đóng hoàn toàn.`);
        }
        else if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi đóng từng phần.`);
            stopBotLogicInternal();
        }
    }
}

/**
 * Hàm mở thêm vị thế khi giá lệnh lãi trở về 0% sau khi đã đóng từng phần.
 * Cần chỉ định rõ positionSide để mở lệnh trong Hedge Mode.
 * @param {object} position - Vị thế cần mở thêm.
 * @param {number} amountToReopen - Số vốn USDT cần mở thêm.
 * @param {string} type - 'PROFIT' hoặc 'LOSS'. Xác định số tiền này là để bù cho khoản đã đóng từ lãi hay lỗ.
 */
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

        // Sử dụng maxLeverageUsed đã lưu trong vị thế
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
            positionSide: position.side, // THÊM positionSide
            type: 'MARKET',
            quantity: quantityToAdd,
            newOrderRespType: 'FULL'
        });

        addLog(`Đã gửi lệnh MARKET để mở thêm ${orderSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000);

        // Lấy lại vị thế trên sàn để cập nhật entryPrice và quantity
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const updatedPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (updatedPositionOnBinance) {
            // Cập nhật entryPrice và quantity của vị thế đã có
            const oldTotalCost = position.entryPrice * position.quantity;
            const newTotalCost = parseFloat(updatedPositionOnBinance.entryPrice) * Math.abs(parseFloat(updatedPositionOnBinance.positionAmt));
            const newTotalQuantity = Math.abs(parseFloat(updatedPositionOnBinance.positionAmt));
            const newEntryPrice = newTotalCost / newTotalQuantity;

            position.entryPrice = newEntryPrice;
            position.quantity = newTotalQuantity;

            addLog(`Đã mở thêm thành công cho ${position.side} ${position.symbol}. Số lượng mới: ${position.quantity.toFixed(quantityPrecision)}, Giá vào trung bình mới: ${newEntryPrice.toFixed(pricePrecision)}.`);

            // Reset closedAmount hoặc closedLossAmount tương ứng
            if (type === 'PROFIT') {
                position.closedAmount = 0;
                position.nextPartialCloseIndex = 0; // Reset index để có thể đóng từng phần lại từ đầu
            } else { // type === 'LOSS'
                position.closedLossAmount = 0;
                position.nextPartialCloseLossIndex = 0; // Reset index đóng lỗ
            }
            
            position.hasAdjustedSLTo200PercentProfit = false; // Reset cờ điều chỉnh SL
            position.hasAdjustedSLTo500PercentProfit = false; // Reset cờ điều chỉnh SL

            // Cập nhật lại TP và SL cho vị thế tổng cộng
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

/**
 * Hàm cập nhật lại lệnh TP và SL cho tổng vị thế sau khi mở thêm.
 * Mục tiêu là giữ nguyên giá TP/SL ban đầu cho toàn bộ vị thế.
 * @param {object} position - Vị thế cần cập nhật TP/SL.
 * @param {number} maxLeverage - Đòn bẩy tối đa của symbol.
 */
async function updateTPandSLForTotalPosition(position, maxLeverage) {
    addLog(`Đang cập nhật TP/SL cho tổng vị thế ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể cập nhật TP/SL.`);
            return;
        }
        const { pricePrecision, tickSize } = symbolDetails;

        // Hủy lệnh SL cũ (chỉ SL, không TP)
        if (position.currentSLId) {
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side); // THÊM position.side
            position.currentSLId = null;
            await sleep(500);
        }

        // --- Xác định STOP_LOSS_MULTIPLIER dựa trên đòn bẩy
        let STOP_LOSS_MULTIPLIER;
        if (maxLeverage >= 75) {
            STOP_LOSS_MULTIPLIER = 6.66; // 666%
        } else if (maxLeverage === 50) {
            STOP_LOSS_MULTIPLIER = 3.33; // 333%
        } else if (maxLeverage < 50) { // Đòn bẩy dưới 50 (bao gồm x25)
            STOP_LOSS_MULTIPLIER = 2.22; // 222%
        } else {
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc SL. Sử dụng mặc định 222%.`);
            STOP_LOSS_MULTIPLIER = 2.22;
        }

        const lossLimitUSDT = INITIAL_INVESTMENT_AMOUNT * STOP_LOSS_MULTIPLIER; // Luôn dùng vốn ban đầu cho 1 lệnh
        const priceChangeForSL = lossLimitUSDT / position.quantity; // Chia cho tổng quantity hiện tại

        let newSLPrice;
        const slOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';

        if (position.side === 'LONG') {
            newSLPrice = position.entryPrice - priceChangeForSL;
            newSLPrice = Math.floor(newSLPrice / tickSize) * tickSize; // Làm tròn xuống
        } else { // SHORT
            newSLPrice = position.entryPrice + priceChangeForSL;
            newSLPrice = Math.ceil(newSLPrice / tickSize) * tickSize; // Làm tròn lên
        }
        newSLPrice = parseFloat(newSLPrice.toFixed(pricePrecision));

        // Đặt lệnh SL mới cho tổng vị thế
        try {
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: slOrderSide,
                positionSide: position.side, // THÊM positionSide
                type: 'STOP_MARKET',
                quantity: position.quantity,
                stopPrice: newSLPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            position.currentSLId = slOrderResult.orderId;
            position.initialSLPrice = newSLPrice; // Cập nhật lại initialSLPrice (thực ra là current SL)
            addLog(`Đã đặt lại SL cho ${position.side} ${position.symbol} @ ${newSLPrice.toFixed(pricePrecision)}. OrderId: ${slOrderResult.orderId}`);
        } catch (slError) {
            addLog(`Lỗi đặt lại SL cho ${position.side} ${position.symbol}: ${slError.msg || slError.message}.`);
            // Xử lý nếu SL bị kích hoạt ngay lập tức
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
                await closePosition(position.symbol, position.quantity, `SL ${position.side} kích hoạt ngay sau mở thêm`, position.side);
                return;
            }
        }
        await sleep(500);

        // Không hủy và đặt lại TP ban đầu
        // Đảm bảo TP ban đầu vẫn còn nếu nó chưa khớp.
        // Nếu TP đã bị hủy bởi người dùng, bot sẽ không đặt lại.
        // Logic sẽ dựa vào việc lệnh TP ban đầu không bị hủy bởi bot.

    } catch (error) {
        addLog(`Lỗi khi cập nhật TP/SL cho tổng vị thế ${position.symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi cập nhật TP/SL sau mở thêm.`);
            stopBotLogicInternal();
        }
    }
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Hàm mở lệnh (Long hoặc Short) và đặt TP/SL ban đầu.
 * Cần chỉ định rõ positionSide để mở lệnh trong Hedge Mode.
 * @param {string} symbol - Cặp giao dịch.
 * @param {string} tradeDirection - 'LONG' hoặc 'SHORT'. Đây cũng là positionSide.
 * @param {number} usdtBalance - Số dư USDT khả dụng.
 * @param {number} maxLeverage - Đòn bẩy tối đa cho symbol.
 * @returns {object|null} Thông tin vị thế đã mở hoặc null nếu lỗi.
 */
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (symbol !== TARGET_COIN_SYMBOL) {
        addLog(`Bỏ qua mở lệnh cho ${symbol}. Chỉ mở lệnh cho ${TARGET_COIN_SYMBOL}.`);
        return null;
    }

    // Kiểm tra xem vị thế cùng chiều đã mở chưa để tránh trùng lặp
    if ((tradeDirection === 'LONG' && currentLongPosition) || (tradeDirection === 'SHORT' && currentShortPosition)) {
        addLog(`Đã có vị thế ${tradeDirection} mở cho ${symbol}. Bỏ qua mở lệnh mới.`);
        return null;
    }

    addLog(`Đang chuẩn bị mở ${tradeDirection} ${symbol}.`);
    addLog(`Mở lệnh với số vốn: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`);
            return null;
        }

        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`);
            return null;
        }
        await sleep(500);

        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            return null;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = INITIAL_INVESTMENT_AMOUNT;

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}).`);
            // Trong chiến lược hedging, nếu không đủ cho 1 lệnh, có thể dừng toàn bộ chu kỳ nếu không có đủ vốn cho cả 2
            return null;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity <= 0 || quantity * currentPrice < minNotional) {
            addLog(`Số lượng hoặc giá trị lệnh quá nhỏ (${quantity.toFixed(quantityPrecision)} Qty, Notional: ${quantity * currentPrice}). Hủy.`);
            return null;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            positionSide: tradeDirection, // THÊM positionSide, bằng tradeDirection
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        });

        addLog(`Đã gửi lệnh MARKET để mở ${tradeDirection} ${symbol}. OrderId: ${orderResult.orderId}`);
        // await sleep(1000); // Đã chuyển logic kiểm tra và đặt TP/SL sang checkAndRecreateTPAndSL sau 30s
        // await sleep(1000); // Giảm bớt sleep sau khi gửi lệnh mở

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === tradeDirection && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            addLog(`Không tìm thấy vị thế mở ${tradeDirection} cho ${symbol} sau khi gửi lệnh. Có thể lệnh không khớp hoặc đã đóng ngay lập tức.`);
            return null;
        }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt));
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now()));
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`Đã mở ${tradeDirection} ${symbol} lúc ${formattedOpenTime}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x | Vốn: ${capitalToUse.toFixed(2)} USDT | Qty thực tế: ${actualQuantity} ${symbol} | Giá vào thực tế: ${entryPrice.toFixed(pricePrecision)}`);

        // --- Hủy tất cả các lệnh chờ hiện tại (TP/SL) nếu có trước khi đặt lại ---
        // Quan trọng: Chỉ hủy các lệnh chờ cho positionSide cụ thể
        await cancelOpenOrdersForSymbol(symbol, null, tradeDirection);
        addLog(`Đã hủy các lệnh chờ cũ (nếu có) cho ${symbol} (PositionSide: ${tradeDirection}).`);
        await sleep(500);

        // --- BẮT ĐẦU TÍNH TOÁN TP/SL THEO % VỐN (dùng giá vào lệnh thực tế và số lượng thực tế) ---
        let TAKE_PROFIT_MULTIPLIER; // Ví dụ: 10 cho 1000%
        let STOP_LOSS_MULTIPLIER; // Ví dụ: 7 cho 700%
        let partialCloseSteps = []; // Các mốc % lãi để đóng từng phần lệnh lãi
        let partialCloseLossSteps = []; // Các mốc % lãi của lệnh lãi để đóng lệnh lỗ

        // Cấu hình SL ban đầu, TP và các mốc đóng từng phần theo đòn bẩy
        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; // 1000%
            STOP_LOSS_MULTIPLIER = 6.66; // **666%**
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 100); // 100%, 200%, ..., 900%
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); // 100%, 200%, ..., 800% (cho 8 lần đóng)
        } else if (maxLeverage === 50) {
            TAKE_PROFIT_MULTIPLIER = 5;  // 500%
            STOP_LOSS_MULTIPLIER = 3.33; // **333%**
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 50); // 50%, 100%, ..., 450%
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); // 50%, 100%, ..., 400% (cho 8 lần đóng)
        } else if (maxLeverage < 50) { // Đòn bẩy dưới 50 (bao gồm x25)
            TAKE_PROFIT_MULTIPLIER = 3.5; // 350%
            STOP_LOSS_MULTIPLIER = 2.22; // **222%**
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 35); // 35%, 70%, 105%, ..., 315%
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); // 35%, 70%, ..., 280% (cho 8 lần đóng)
        } else {
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc TP/SL/Partial Close. Sử dụng mặc định (TP 350%, SL 222%, Partial 35%).`);
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 2.22;
            for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 35);
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35);
        }

        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_MULTIPLIER;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_MULTIPLIER;

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        if (tradeDirection === 'LONG') {
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            slOrderSide = 'SELL'; // Bán để đóng LONG
            tpOrderSide = 'SELL'; // Bán để đóng LONG

            slPrice = Math.floor(slPrice / tickSize) * tickSize; // Làm tròn xuống cho SL của LONG
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize; // Làm tròn xuống cho TP của LONG

        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP; // Đã sửa
            slOrderSide = 'BUY'; // Mua để đóng SHORT
            tpOrderSide = 'BUY'; // Mua để đóng SHORT

            slPrice = Math.ceil(slPrice / tickSize) * tickSize; // Làm tròn lên cho SL của SHORT
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize; // Làm tròn lên cho TP của SHORT
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`Giá Entry ${tradeDirection}: ${entryPrice.toFixed(pricePrecision)}`);
        addLog(`TP ${tradeDirection}: ${tpPrice.toFixed(pricePrecision)} (target ${TAKE_PROFIT_MULTIPLIER * 100}% vốn), SL ${tradeDirection}: ${slPrice.toFixed(pricePrecision)} (limit ${STOP_LOSS_MULTIPLIER * 100}% vốn)`);

        let placedSLOrderId = null;
        // Sửa đổi 2: chỉnh sau khi đặt lệnh 3s cài tp sl ban đầu
        // Đặt lệnh SL ban đầu ngay sau khi mở lệnh.
        try {
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: slOrderSide,
                positionSide: tradeDirection, // THÊM positionSide
                type: 'STOP_MARKET',
                quantity: actualQuantity,
                stopPrice: slPrice,
                closePosition: 'true', // Dùng closePosition=true với STOP_MARKET/TAKE_PROFIT_MARKET
                newOrderRespType: 'FULL'
            });
            placedSLOrderId = slOrderResult.orderId;
            addLog(`Đã đặt SL cho ${tradeDirection} ${symbol} @ ${slPrice.toFixed(pricePrecision)}. OrderId: ${placedSLOrderId}`);
            await sleep(500);
        } catch (slError) {
            addLog(`Lỗi đặt SL cho ${tradeDirection} ${symbol}: ${slError.msg || slError.message}.`);
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${tradeDirection} ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, `SL ${tradeDirection} kích hoạt ngay`, tradeDirection);
                return null;
            }
        }

        let placedTPOrderId = null;
        // Sửa đổi 2: chỉnh sau khi đặt lệnh 3s cài tp sl ban đầu
        // Đặt lệnh TP ban đầu ngay sau khi mở lệnh.
        try {
            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: tpOrderSide,
                positionSide: tradeDirection, // THÊM positionSide
                type: 'TAKE_PROFIT_MARKET',
                quantity: actualQuantity,
                stopPrice: tpPrice,
                closePosition: 'true', // Dùng closePosition=true
                newOrderRespType: 'FULL'
            });
            placedTPOrderId = tpOrderResult.orderId;
            addLog(`Đã đặt TP cho ${tradeDirection} ${symbol} @ ${tpPrice.toFixed(pricePrecision)}. OrderId: ${placedTPOrderId}`);
            await sleep(500);
        } catch (tpError) {
            addLog(`Lỗi đặt TP cho ${tradeDirection} ${symbol}: ${tpError.msg || tpError.message}.`);
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${tradeDirection} ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, `TP ${tradeDirection} kích hoạt ngay`, tradeDirection);
                return null;
            }
        }

        const positionData = {
            symbol: symbol,
            quantity: actualQuantity,
            initialQuantity: actualQuantity, // <-- THÊM THUỘC TÍNH NÀY
            entryPrice: entryPrice,
            initialTPPrice: tpPrice, // Giá TP ban đầu
            initialSLPrice: slPrice, // Giá SL ban đầu
            initialMargin: capitalToUse,
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection, // Lưu tradeDirection làm side (LONG/SHORT)
            currentPrice: currentPrice, // Giá hiện tại (sẽ cập nhật liên tục)
            unrealizedPnl: 0, // Sẽ cập nhật liên tục
            currentTPId: placedTPOrderId, // OrderId của lệnh TP
            currentSLId: placedSLOrderId, // OrderId của lệnh SL
            closedAmount: 0, // Tổng số vốn (ban đầu) đã đóng từng phần từ lệnh lãi
            partialCloseLevels: partialCloseSteps, // Các mốc % lãi để đóng từng phần lệnh lãi
            nextPartialCloseIndex: 0, // Index của mốc đóng từng phần lệnh lãi tiếp theo
            closedLossAmount: 0, // Tổng số vốn (ban đầu) đã đóng từng phần từ lệnh lỗ
            partialCloseLossLevels: partialCloseLossSteps, // Các mốc % lãi của lệnh lãi để đóng lệnh lỗ
            nextPartialCloseLossIndex: 0, // Index của mốc đóng lệnh lỗ tiếp theo

            // Thêm các cờ để quản lý trạng thái SL điều chỉnh
            hasAdjustedSLTo200PercentProfit: false, // Cờ này sẽ chuyển thành true khi SL được điều chỉnh về mốc 200% lãi
            hasAdjustedSLTo500PercentProfit: false, // Cờ này sẽ chuyển thành true khi SL được điều chỉnh về mốc 500% lãi
            maxLeverageUsed: maxLeverage, // Lưu đòn bẩy để không cần gọi API nhiều lần
        };

        return positionData;

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`);
            stopBotLogicInternal();
        } else {
            addLog(`Đợi 2 giây trước khi lên lịch chu kỳ mới sau lỗi mở lệnh.`);
            return null; // Trả về null để runTradingLogic có thể xử lý
        }
    }
}

/**
 * Hàm hủy và đặt lại lệnh SL cho một vị thế.
 * LƯU Ý QUAN TRỌNG: Sẽ không hủy lệnh TP.
 * @param {object} position - Vị thế cần điều chỉnh SL (có thể là lệnh lãi hoặc lệnh đối ứng).
 * @param {number} targetSLPrice - Giá SL mục tiêu.
 */
async function updateStopLoss(position, targetSLPrice) {
    addLog(`Đang điều chỉnh SL cho lệnh ${position.side} ${position.symbol} về giá: ${targetSLPrice}.`);

    // Chỉ hủy lệnh SL hiện có của vị thế đó, đảm bảo hủy đúng positionSide
    if (position.currentSLId) {
        await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side); // THÊM position.side
        position.currentSLId = null;
        await sleep(1000); // Đợi lệnh hủy hoàn tất
    } else {
        addLog(`Không tìm thấy lệnh SL hiện có cho ${position.side} ${position.symbol} để hủy.`);
    }

    const symbolDetails = await getSymbolDetails(position.symbol);
    if (!symbolDetails) {
        addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể điều chỉnh SL.`);
        return;
    }
    const { pricePrecision } = symbolDetails;

    // Đặt lại SL mới cho vị thế đó
    try {
        const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: position.side === 'LONG' ? 'SELL' : 'BUY', // Side ngược lại để đóng vị thế
            positionSide: position.side, // THÊM positionSide
            type: 'STOP_MARKET',
            quantity: position.quantity,
            stopPrice: targetSLPrice,
            closePosition: 'true',
            newOrderRespType: 'FULL'
        });
        position.currentSLId = slOrderResult.orderId;
        // Cập nhật initialSLPrice (thực ra là current SL) để theo dõi
        position.initialSLPrice = targetSLPrice;
        addLog(`Đã điều chỉnh SL cho ${position.side} ${position.symbol} @ ${targetSLPrice.toFixed(pricePrecision)}. OrderId: ${slOrderResult.orderId}`);
    } catch (slError) {
        addLog(`Lỗi điều chỉnh SL cho ${position.side} ${position.symbol}: ${slError.msg || slError.message}.`);
        if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
            addLog(`SL kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
            await closePosition(position.symbol, position.quantity, `SL kích hoạt ngay khi điều chỉnh`, position.side);
            return;
        }
    }
    await sleep(500);

    // QUAN TRỌNG: KHÔNG HỦY VÀ ĐẶT LẠI TP. Lệnh TP ban đầu sẽ được giữ nguyên.
}

/**
 * Hàm kiểm tra và đặt lại lệnh TP/SL ban đầu cho một vị thế nếu chúng bị thiếu.
 * Được gọi sau khi mở lệnh chính và đợi một khoảng thời gian.
 * @param {object} position - Vị thế cần kiểm tra và đặt lại TP/SL.
 */
async function checkAndRecreateTPAndSL(position) {
    if (!position || !botRunning) return;

    addLog(`Đang kiểm tra lệnh TP/SL ban đầu cho ${position.side} ${position.symbol}.`);
    const symbolDetails = await getSymbolDetails(position.symbol);
    if (!symbolDetails) {
        addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể kiểm tra TP/SL.`);
        return;
    }
    const { pricePrecision } = symbolDetails;

    const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: position.symbol });
    const hasTP = openOrders.some(o => o.orderId === position.currentTPId && o.status === 'NEW' && o.type === 'TAKE_PROFIT_MARKET' && o.positionSide === position.side);
    const hasSL = openOrders.some(o => o.orderId === position.currentSLId && o.status === 'NEW' && o.type === 'STOP_MARKET' && o.positionSide === position.side);

    // Kiểm tra và đặt lại SL nếu cần
    if (!hasSL || !position.currentSLId) {
        addLog(`Lệnh SL ban đầu cho ${position.side} ${position.symbol} bị thiếu hoặc không khớp. Đang đặt lại.`);
        try {
            const slOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: slOrderSide,
                positionSide: position.side,
                type: 'STOP_MARKET',
                quantity: position.quantity,
                stopPrice: position.initialSLPrice, // Sử dụng giá SL ban đầu
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            position.currentSLId = slOrderResult.orderId;
            addLog(`Đã đặt lại SL cho ${position.side} ${position.symbol} @ ${position.initialSLPrice.toFixed(pricePrecision)}. OrderId: ${slOrderResult.orderId}`);
        } catch (error) {
            addLog(`Lỗi đặt lại SL cho ${position.side} ${position.symbol}: ${error.msg || error.message}.`);
        }
    } else {
        addLog(`Lệnh SL ban đầu cho ${position.side} ${position.symbol} đã có. ID: ${position.currentSLId}`);
    }

    // Kiểm tra và đặt lại TP nếu cần
    if (!hasTP || !position.currentTPId) {
        addLog(`Lệnh TP ban đầu cho ${position.side} ${position.symbol} bị thiếu hoặc không khớp. Đang đặt lại.`);
        try {
            const tpOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';
            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: tpOrderSide,
                positionSide: position.side,
                type: 'TAKE_PROFIT_MARKET',
                quantity: position.quantity,
                stopPrice: position.initialTPPrice, // Sử dụng giá TP ban đầu
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            position.currentTPId = tpOrderResult.orderId;
            addLog(`Đã đặt lại TP cho ${position.side} ${position.symbol} @ ${position.initialTPPrice.toFixed(pricePrecision)}. OrderId: ${tpOrderResult.orderId}`);
        } catch (error) {
            addLog(`Lỗi đặt lại TP cho ${position.side} ${position.symbol}: ${error.msg || error.message}.`);
        }
    } else {
        addLog(`Lệnh TP ban đầu cho ${position.side} ${position.symbol} đã có. ID: ${position.currentTPId}`);
    }
}


/**
 * Hàm kiểm tra và quản lý vị thế đang mở (chỉ cập nhật PNL chưa hiện thực hóa)
 */
async function manageOpenPosition() {
    if (!currentLongPosition && !currentShortPosition && positionCheckInterval) {
        addLog('Không còn vị thế mở nào. Dừng kiểm tra định kỳ.');
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        if(botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ mới nếu bot vẫn chạy
        return;
    }

    if (isClosingPosition) {
        // addLog('Đang trong quá trình đóng vị thế, bỏ qua quản lý vị thế.'); // Giảm bớt log này
        return;
    }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        let hasActivePosition = false;

        // Cập nhật trạng thái cho Long Position
        if (currentLongPosition) {
            const longPosOnBinance = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
            if (!longPosOnBinance || parseFloat(longPosOnBinance.positionAmt) === 0) {
                addLog(`Vị thế LONG ${TARGET_COIN_SYMBOL} đã đóng trên sàn. Cập nhật bot.`);
                currentLongPosition = null;
                // Sửa đổi 3: Khi có 1 vị thế bị đóng hoàn toàn với bất kỳ lý do gì => đóng nốt vị thế còn lại để chạy chu kỳ mới.
                // Nếu LONG bị đóng, kiểm tra và đóng SHORT nếu còn.
                if (currentShortPosition && Math.abs(currentShortPosition.quantity) > 0) {
                    addLog(`Vị thế LONG đã đóng. Đang đóng nốt vị thế SHORT còn lại.`);
                    await closePosition(currentShortPosition.symbol, currentShortPosition.quantity, 'Lệnh đối ứng LONG đã đóng', currentShortPosition.side);
                    currentShortPosition = null; // Đảm bảo reset trạng thái
                }
            } else {
                currentLongPosition.unrealizedPnl = parseFloat(longPosOnBinance.unRealizedProfit);
                currentLongPosition.currentPrice = parseFloat(longPosOnBinance.markPrice);
                currentLongPosition.quantity = Math.abs(parseFloat(longPosOnBinance.positionAmt)); // Cập nhật lại số lượng thực tế
                hasActivePosition = true;
            }
        }

        // Cập nhật trạng thái cho Short Position
        if (currentShortPosition) {
            const shortPosOnBinance = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);
            if (!shortPosOnBinance || parseFloat(shortPosOnBinance.positionAmt) === 0) {
                addLog(`Vị thế SHORT ${TARGET_COIN_SYMBOL} đã đóng trên sàn. Cập nhật bot.`);
                currentShortPosition = null;
                // Sửa đổi 3: Khi có 1 vị thế bị đóng hoàn toàn với bất kỳ lý do gì => đóng nốt vị thế còn lại để chạy chu kỳ mới.
                // Nếu SHORT bị đóng, kiểm tra và đóng LONG nếu còn.
                if (currentLongPosition && Math.abs(currentLongPosition.quantity) > 0) {
                    addLog(`Vị thế SHORT đã đóng. Đang đóng nốt vị thế LONG còn lại.`);
                    await closePosition(currentLongPosition.symbol, currentLongPosition.quantity, 'Lệnh đối ứng SHORT đã đóng', currentLongPosition.side);
                    currentLongPosition = null; // Đảm bảo reset trạng thái
                }
            } else {
                currentShortPosition.unrealizedPnl = parseFloat(shortPosOnBinance.unRealizedProfit);
                currentShortPosition.currentPrice = parseFloat(shortPosOnBinance.markPrice);
                currentShortPosition.quantity = Math.abs(parseFloat(shortPosOnBinance.positionAmt)); // Cập nhật lại số lượng thực tế
                hasActivePosition = true;
            }
        }

        // --- Logic đóng từng phần và điều chỉnh SL cho CẢ HAI LỆNH ---
        let winningPos = null;
        let losingPos = null; // Lệnh đối ứng hoặc lệnh lỗ

        if (currentLongPosition && currentLongPosition.unrealizedPnl > 0) {
            winningPos = currentLongPosition;
            losingPos = currentShortPosition;
        } else if (currentShortPosition && currentShortPosition.unrealizedPnl > 0) {
            winningPos = currentShortPosition;
            losingPos = currentLongPosition;
        } else {
            // Trường hợp cả 2 lệnh đều lỗ hoặc hòa vốn
            if (currentLongPosition && currentLongPosition.unrealizedPnl < 0) losingPos = currentLongPosition;
            if (currentShortPosition && currentShortPosition.unrealizedPnl < 0 && (!losingPos || currentShortPosition.unrealizedPnl < losingPos.unrealizedPnl)) losingPos = currentShortPosition;
        }

        // 1. Logic đóng từng phần lệnh lãi
        if (winningPos) {
            const currentWinningProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
            const nextCloseLevel = winningPos.partialCloseLevels[winningPos.nextPartialCloseIndex];
            if (nextCloseLevel && currentWinningProfitPercentage >= nextCloseLevel) {
                addLog(`Lệnh ${winningPos.side} đạt mốc lãi ${nextCloseLevel}%. Đang đóng 10% khối lượng ban đầu.`);
                await closePartialPosition(winningPos, 10, 'PROFIT'); // Đóng 10% khối lượng ban đầu
                winningPos.nextPartialCloseIndex++; // Chuyển sang mốc tiếp theo
            }

            // 2. Logic điều chỉnh SL cho CẢ HAI LỆNH
            const symbolDetails = await getSymbolDetails(winningPos.symbol);
            const tickSize = symbolDetails ? symbolDetails.tickSize : 0.001;
            const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;

            let slPriceForWinningPos_SpecificProfit; // Giá SL cho lệnh lãi
            let slPriceForLosingPos_Breakeven = losingPos ? parseFloat(losingPos.entryPrice.toFixed(pricePrecision)) : null; // Giá SL cho lệnh lỗ về hòa vốn

            // Dựa vào đòn bẩy đã sử dụng
            const maxLeverage = winningPos.maxLeverageUsed;

            if (maxLeverage >= 75) {
                // Đòn bẩy 75:
                // Mốc 500% (mốc 5) -> SL về 200% lãi
                if (currentWinningProfitPercentage >= 500 && !winningPos.hasAdjustedSLTo200PercentProfit) {
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG'
                        ? winningPos.entryPrice + (winningPos.initialMargin * 200 / 100 / winningPos.quantity)
                        : winningPos.entryPrice - (winningPos.initialMargin * 200 / 100 / winningPos.quantity);
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG' ? Math.floor(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize : Math.ceil(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize;
                    slPriceForWinningPos_SpecificProfit = parseFloat(slPriceForWinningPos_SpecificProfit.toFixed(pricePrecision));

                    addLog(`Lệnh ${winningPos.side} (x${maxLeverage}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 200% lãi và SL của lệnh đối ứng về hòa vốn (mốc 500%).`);
                    await updateStopLoss(winningPos, slPriceForWinningPos_SpecificProfit);
                    if (losingPos) {
                        await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven);
                    }
                    winningPos.hasAdjustedSLTo200PercentProfit = true;
                }
                // Mốc 800% (mốc 8) -> SL về 500% lãi
                if (currentWinningProfitPercentage >= 800 && !winningPos.hasAdjustedSLTo500PercentProfit) {
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG'
                        ? winningPos.entryPrice + (winningPos.initialMargin * 500 / 100 / winningPos.quantity)
                        : winningPos.entryPrice - (winningPos.initialMargin * 500 / 100 / winningPos.quantity);
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG' ? Math.floor(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize : Math.ceil(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize;
                    slPriceForWinningPos_SpecificProfit = parseFloat(slPriceForWinningPos_SpecificProfit.toFixed(pricePrecision));

                    addLog(`Lệnh ${winningPos.side} (x${maxLeverage}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 500% lãi và SL của lệnh đối ứng về hòa vốn (mốc 800%).`);
                    await updateStopLoss(winningPos, slPriceForWinningPos_SpecificProfit);
                    if (losingPos) {
                        await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven);
                    }
                    winningPos.hasAdjustedSLTo500PercentProfit = true;
                    winningPos.hasAdjustedSLTo200PercentProfit = true; // Đảm bảo cờ 200% cũng được bật
                }
            } else if (maxLeverage === 50) {
                // Đòn bẩy 50:
                // Mốc 250% -> SL về 100% lãi
                if (currentWinningProfitPercentage >= 250 && !winningPos.hasAdjustedSLTo200PercentProfit) { // Đặt cờ này để đại diện cho mốc 100%
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG'
                        ? winningPos.entryPrice + (winningPos.initialMargin * 100 / 100 / winningPos.quantity)
                        : winningPos.entryPrice - (winningPos.initialMargin * 100 / 100 / winningPos.quantity);
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG' ? Math.floor(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize : Math.ceil(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize;
                    slPriceForWinningPos_SpecificProfit = parseFloat(slPriceForWinningPos_SpecificProfit.toFixed(pricePrecision));

                    addLog(`Lệnh ${winningPos.side} (x${maxLeverage}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 100% lãi và SL của lệnh đối ứng về hòa vốn (mốc 250%).`);
                    await updateStopLoss(winningPos, slPriceForWinningPos_SpecificProfit);
                    if (losingPos) {
                        await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven);
                    }
                    winningPos.hasAdjustedSLTo200PercentProfit = true; // Sử dụng cờ này cho mốc 100%
                }
                // Mốc 400% -> SL về 250% lãi
                if (currentWinningProfitPercentage >= 400 && !winningPos.hasAdjustedSLTo500PercentProfit) { // Đặt cờ này để đại diện cho mốc 250%
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG'
                        ? winningPos.entryPrice + (winningPos.initialMargin * 250 / 100 / winningPos.quantity)
                        : winningPos.entryPrice - (winningPos.initialMargin * 250 / 100 / winningPos.quantity);
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG' ? Math.floor(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize : Math.ceil(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize;
                    slPriceForWinningPos_SpecificProfit = parseFloat(slPriceForWinningPos_SpecificProfit.toFixed(pricePrecision));

                    addLog(`Lệnh ${winningPos.side} (x${maxLeverage}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 250% lãi và SL của lệnh đối ứng về hòa vốn (mốc 400%).`);
                    await updateStopLoss(winningPos, slPriceForWinningPos_SpecificProfit);
                    if (losingPos) {
                        await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven);
                    }
                    winningPos.hasAdjustedSLTo500PercentProfit = true; // Sử dụng cờ này cho mốc 250%
                    winningPos.hasAdjustedSLTo200PercentProfit = true; // Đảm bảo cờ trước đó cũng được bật
                }
            } else if (maxLeverage < 50) { // Đòn bẩy dưới 50 (bao gồm x25)
                // Mốc 175% -> SL về 70% lãi
                if (currentWinningProfitPercentage >= 175 && !winningPos.hasAdjustedSLTo200PercentProfit) { // Cờ này đại diện cho 70%
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG'
                        ? winningPos.entryPrice + (winningPos.initialMargin * 70 / 100 / winningPos.quantity)
                        : winningPos.entryPrice - (winningPos.initialMargin * 70 / 100 / winningPos.quantity);
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG' ? Math.floor(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize : Math.ceil(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize;
                    slPriceForWinningPos_SpecificProfit = parseFloat(slPriceForWinningPos_SpecificProfit.toFixed(pricePrecision));

                    addLog(`Lệnh ${winningPos.side} (x${maxLeverage}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 70% lãi và SL của lệnh đối ứng về hòa vốn (mốc 175%).`);
                    await updateStopLoss(winningPos, slPriceForWinningPos_SpecificProfit);
                    if (losingPos) {
                        await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven);
                    }
                    winningPos.hasAdjustedSLTo200PercentProfit = true; // Sử dụng cờ này cho mốc 70%
                }
                // Mốc 280% -> SL về 175% lãi
                if (currentWinningProfitPercentage >= 280 && !winningPos.hasAdjustedSLTo500PercentProfit) { // Cờ này đại diện cho 175%
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG'
                        ? winningPos.entryPrice + (winningPos.initialMargin * 175 / 100 / winningPos.quantity)
                        : winningPos.entryPrice - (winningPos.initialMargin * 175 / 100 / winningPos.quantity);
                    slPriceForWinningPos_SpecificProfit = winningPos.side === 'LONG' ? Math.floor(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize : Math.ceil(slPriceForWinningPos_SpecificProfit / tickSize) * tickSize;
                    slPriceForWinningPos_SpecificProfit = parseFloat(slPriceForWinningPos_SpecificProfit.toFixed(pricePrecision));

                    addLog(`Lệnh ${winningPos.side} (x${maxLeverage}) đạt ${currentWinningProfitPercentage.toFixed(2)}% lãi. Điều chỉnh SL của lệnh lãi về 175% lãi và SL của lệnh đối ứng về hòa vốn (mốc 280%).`);
                    await updateStopLoss(winningPos, slPriceForWinningPos_SpecificProfit);
                    if (losingPos) {
                        await updateStopLoss(losingPos, slPriceForLosingPos_Breakeven);
                    }
                    winningPos.hasAdjustedSLTo500PercentProfit = true; // Sử dụng cờ này cho mốc 175%
                    winningPos.hasAdjustedSLTo200PercentProfit = true; // Đảm bảo cờ trước đó cũng được bật
                }
            }


            // --- 3. Logic đóng từng phần lệnh lỗ dựa trên % lãi của lệnh lãi ---
            if (losingPos && losingPos.unrealizedPnl < 0) { // Đảm bảo có lệnh lỗ và đang lỗ
                const nextLossCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
                if (nextLossCloseLevel && currentWinningProfitPercentage >= nextLossCloseLevel) {
                    addLog(`Lệnh ${winningPos.side} đạt mốc lãi ${nextLossCloseLevel}%. Đang đóng 10% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ).`);
                    await closePartialPosition(losingPos, 10, 'LOSS'); // Đóng 10% khối lượng ban đầu của lệnh lỗ
                    winningPos.nextPartialCloseLossIndex++; // Chuyển sang mốc đóng lỗ tiếp theo
                    // Nếu đã đóng đủ 8 lần (80% vốn ban đầu), có thể đóng toàn bộ lệnh lỗ.
                    if (winningPos.nextPartialCloseLossIndex >= 8) {
                        addLog(`Lệnh ${winningPos.side} đã đạt ${nextLossCloseLevel}%. Đã đóng 8 lần lệnh lỗ. Đang đóng toàn bộ lệnh lỗ ${losingPos.side}.`);
                        await closePosition(losingPos.symbol, losingPos.quantity, `Đóng toàn bộ lệnh lỗ khi lệnh lãi đạt ${nextLossCloseLevel}%`, losingPos.side);
                    }
                }
            }
        }

        // 4. Logic "giá lệnh lãi trở về 0% => mở thêm số $ đã đóng"
        if (currentLongPosition && currentLongPosition.closedAmount > 0) {
            const currentProfitPercentage = (currentLongPosition.unrealizedPnl / currentLongPosition.initialMargin) * 100;
            if (currentProfitPercentage <= 0.1) { // Coi như 0% lãi (có thể thêm một ngưỡng nhỏ để tránh rung lắc)
                addLog(`Lệnh LONG đã đóng từng phần lãi và lãi trở về 0% (${currentProfitPercentage.toFixed(2)}%). Đang mở thêm số vốn đã đóng.`);
                await addPosition(currentLongPosition, currentLongPosition.closedAmount, 'PROFIT');
            }
        }
        if (currentShortPosition && currentShortPosition.closedAmount > 0) {
            const currentProfitPercentage = (currentShortPosition.unrealizedPnl / currentShortPosition.initialMargin) * 100;
            if (currentProfitPercentage <= 0.1) { // Coi như 0% lãi
                addLog(`Lệnh SHORT đã đóng từng phần lãi và lãi trở về 0% (${currentProfitPercentage.toFixed(2)}%). Đang mở thêm số vốn đã đóng.`);
                await addPosition(currentShortPosition, currentShortPosition.closedAmount, 'PROFIT');
            }
        }
        
        // 5. Logic "khi lệnh lãi chạm từ mốc đóng 1 phần trở lên và lệnh lãi về 0% => mở thêm những phần đã đóng của lệnh lỗ"
        // Lệnh lãi về 0% và đã từng đóng lỗ:
        if (winningPos && winningPos.closedLossAmount > 0) { // winningPos là lệnh lãi đang có
             const currentWinningProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
             if (currentWinningProfitPercentage <= 0.1) { // Nếu lệnh lãi về 0%
                if (losingPos) { // Đảm bảo có lệnh lỗ để mở thêm
                    addLog(`Lệnh ${winningPos.side} đã đóng từng phần lỗ và lãi trở về 0% (${currentWinningProfitPercentage.toFixed(2)}%). Đang mở thêm số vốn đã cắt lỗ cho lệnh ${losingPos.side}.`);
                    await addPosition(losingPos, losingPos.closedLossAmount, 'LOSS');
                } else {
                    addLog(`Lệnh ${winningPos.side} đã đóng từng phần lỗ và lãi trở về 0% nhưng không tìm thấy lệnh lỗ để mở thêm.`);
                }
             }
        }


        if (!hasActivePosition) {
            addLog(`Đã xác nhận không còn vị thế mở nào cho ${TARGET_COIN_SYMBOL}.`);
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            if(botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ mới nếu bot vẫn chạy
        }

    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở cho ${TARGET_COIN_SYMBOL}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế.`);
             stopBotLogicInternal();
             if (!retryBotTimeout) {
                                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('Thử khởi động lại bot...');
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, ERROR_RETRY_DELAY_MS);
                            }
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot (đã bỏ delay)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét.');
        return;
    }

    if (currentLongPosition || currentShortPosition) {
        addLog('Có vị thế mở. Bỏ qua quét mới.');
        return;
    }

    clearTimeout(nextScheduledCycleTimeout);

    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
}

// --- HÀM CHO WEBSOCKET LISTENKEY VÀ KẾT NỐI ---

async function getListenKey() {
    if (!API_KEY || !SECRET_KEY) {
        addLog("API Key hoặc Secret Key chưa được cấu hình. Không thể lấy listenKey.");
        return null;
    }
    try {
        const data = await callSignedAPI('/fapi/v1/listenKey', 'POST');
        addLog(`Đã lấy listenKey mới: ${data.listenKey}`);
        return data.listenKey;
    } catch (error) {
        addLog(`Lỗi khi lấy listenKey: ${error.msg || error.message}`);
        return null;
    }
}

async function keepAliveListenKey() {
    if (!listenKey) {
        addLog("Không có listenKey để làm mới.");
        return;
    }
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: listenKey });
    } catch (error) {
        addLog(`Lỗi khi làm mới listenKey: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError || error.code === -1000 || error.code === -1125) {
            addLog("Lỗi nghiêm trọng khi làm mới listenKey. Cố gắng lấy listenKey mới.");
            try {
                listenKey = await getListenKey();
                if (listenKey) {
                    setupUserDataStream(listenKey);
                } else {
                    addLog("Không thể lấy listenKey mới sau lỗi làm mới.");
                }
            } catch (e) {
                addLog(`Thêm lỗi khi cố gắng lấy listenKey mới: ${e.message}`);
            }
        }
    }
}

function setupMarketDataStream(symbol) {
    if (marketWs) {
        addLog('Đóng kết nối Market WebSocket cũ...');
        marketWs.close();
        marketWs = null;
    }

    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${symbol.toLowerCase()}@markPrice@1s`;

    addLog(`Kết nối Market WebSocket: ${streamUrl}`);
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => {
        addLog(`Market WebSocket cho ${symbol} đã kết nối.`);
    };

    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'markPriceUpdate' && data.s === TARGET_COIN_SYMBOL) {
                currentMarketPrice = parseFloat(data.p);
                // addLog(`Giá ${symbol} (Mark Price): ${currentMarketPrice}`); // Quá nhiều log, chỉ dùng để debug ban đầu
            }
        } catch (e) {
            addLog(`Lỗi phân tích cú pháp Market WebSocket message: ${e.message}`);
        }
    };

    marketWs.onerror = (error) => {
        addLog(`Market WebSocket lỗi cho ${symbol}: ${error.message}. Đang thử kết nối lại...`);
        setTimeout(() => setupMarketDataStream(symbol), 5000);
    };

    marketWs.onclose = (event) => {
        addLog(`Market WebSocket cho ${symbol} đã đóng. Code: ${event.code}, Reason: ${event.reason}. Đang thử kết nối lại...`);
        marketWs = null;
        if (botRunning) {
            setTimeout(() => setupMarketDataStream(symbol), 5000);
        }
    };
}

function setupUserDataStream(key) {
    if (userDataWs) {
        addLog('Đóng kết nối User Data WebSocket cũ...');
        userDataWs.close();
        userDataWs = null;
    }

    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    addLog(`Kết nối User Data WebSocket: ${streamUrl}`);
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('User Data WebSocket đã kết nối.');
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 1800000);
    };

    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE') {
                const order = data.o;
                // Binance trong ORDER_TRADE_UPDATE cung cấp ps (positionSide)
                if (order.s === TARGET_COIN_SYMBOL && order.X === 'FILLED' && parseFloat(order.rp) !== 0) {
                    addLog(`Phát hiện lệnh khớp. Symbol: ${order.s}, Side: ${order.S}, PNL: ${order.rp}, OrderId: ${order.i}, PositionSide: ${order.ps}`);
                    // Kiểm tra xem lệnh khớp có phải là TP/SL chính của bot không
                    let isBotTPorSL = false;
                    if (currentLongPosition && (order.i === currentLongPosition.currentTPId || order.i === currentLongPosition.currentSLId)) {
                        isBotTPorSL = true;
                    } else if (currentShortPosition && (order.i === currentShortPosition.currentTPId || order.i === currentShortPosition.currentSLId)) {
                        isBotTPorSL = true;
                    }

                    if (isBotTPorSL) {
                        addLog(`Lệnh TP/SL chính cho ${order.ps} đã khớp. Kích hoạt xử lý PNL và reset chu kỳ.`);
                        await processTradeResult(order);
                    } else {
                        // Đây là một lệnh đã khớp khác, có thể là đóng từng phần
                        addLog(`Lệnh khớp ${order.i} PNL = ${order.rp} (PositionSide: ${order.ps}) không phải TP/SL chính. Cập nhật PNL và tiếp tục quản lý vị thế.`);
                        // Mặc dù processTradeResult có PNL, nhưng nó chỉ reset chu kỳ nếu là lệnh TP/SL chính.
                        // Nó vẫn cập nhật totalProfit/Loss.
                        // Hàm manageOpenPosition sẽ chịu trách nhiệm cập nhật trạng thái vị thế (quantity, unrealizedPnl)
                        // một cách định kỳ hoặc sau mỗi sự kiện cần thiết.
                        await processTradeResult(order); // Vẫn gọi để cập nhật PNL tổng
                    }
                } else if (order.s === TARGET_COIN_SYMBOL && order.X === 'FILLED' && parseFloat(order.rp) === 0) {
                    // Lệnh khớp với PNL = 0, có thể là lệnh đóng từng phần hoặc lệnh mở không tạo PNL ngay lập tức
                    addLog(`Lệnh khớp ${order.i} PNL = 0 (PositionSide: ${order.ps}). Giả định là một phần của quy trình giao dịch (ví dụ: lệnh đóng từng phần hoặc mở thêm).`);
                    // Không cần làm gì đặc biệt ở đây, manageOpenPosition sẽ cập nhật trạng thái vị thế tổng thể.
                }
            } else if (data.e === 'ACCOUNT_UPDATE') {
                // Xử lý cập nhật số dư hoặc vị thế nếu cần.
                // Thường thì manageOpenPosition đã đủ để lấy trạng thái vị thế.
            }
        } catch (e) {
            addLog(`Lỗi phân tích cú pháp User Data WebSocket message: ${e.message}`);
        }
    };

    userDataWs.onerror = (error) => {
        addLog(`User Data WebSocket lỗi: ${error.message}. Đang thử kết nối lại...`);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        userDataWs = null;
        if (botRunning) {
            setTimeout(async () => {
                try {
                    listenKey = await getListenKey();
                    if (listenKey) setupUserDataStream(listenKey);
                } catch (e) {
                    addLog(`Không thể kết nối lại User Data Stream: ${e.message}`);
                }
            }, 5000);
        }
    };

    userDataWs.onclose = (event) => {
        addLog(`User Data WebSocket đã đóng. Code: ${event.code}, Reason: ${event.reason}. Đang thử kết nối lại...`);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        userDataWs = null;
        if (botRunning) {
            setTimeout(async () => {
                try {
                    listenKey = await getListenKey();
                    if (listenKey) setupUserDataStream(listenKey);
                } catch (e) {
                    addLog(`Không thể kết nối lại User Data Stream: ${e.message}`);
                }
            }, 5000);
        }
    };
}


// --- HÀM CHÍNH CỦA BOT ---
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot hiện không chạy, bỏ qua chu kỳ giao dịch.');
        return;
    }

    if (currentLongPosition || currentShortPosition) {
        addLog(`Đã có vị thế mở cho ${TARGET_COIN_SYMBOL}. Không mở lệnh mới. Tiếp tục theo dõi.`);
        return;
    }

    addLog('Bắt đầu chu kỳ giao dịch mới: Mở cả hai lệnh LONG và SHORT...');

    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`USDT khả dụng: ${usdtAsset.toFixed(2)}`);

        if (usdtAsset < (INITIAL_INVESTMENT_AMOUNT * 2)) { // Cần đủ tiền cho cả 2 lệnh
            addLog(`Số dư USDT quá thấp (${usdtAsset.toFixed(2)} USDT) để mở cả hai lệnh (${INITIAL_INVESTMENT_AMOUNT * 2} USDT). Dừng mở lệnh. Đợi số dư đủ.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog(`Không thể lấy đòn bẩy cho ${TARGET_COIN_SYMBOL}. Hủy chu kỳ.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        // Mở lệnh LONG
        addLog(`Chuẩn bị mở lệnh LONG cho ${TARGET_COIN_SYMBOL} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT và đòn bẩy ${maxLeverage}x.`);
        currentLongPosition = await openPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage);
        if (!currentLongPosition) {
            addLog('Lỗi khi mở lệnh LONG. Hủy chu kỳ.');
            // Nếu lệnh LONG lỗi, chúng ta không nên cố mở lệnh SHORT.
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        await sleep(2000); // Đợi một chút trước khi mở lệnh thứ hai

        // Mở lệnh SHORT
        addLog(`Chuẩn bị mở lệnh SHORT cho ${TARGET_COIN_SYMBOL} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT và đòn bẩy ${maxLeverage}x.`);
        currentShortPosition = await openPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage);
        if (!currentShortPosition) {
            addLog('Lỗi khi mở lệnh SHORT. Đang cố gắng đóng lệnh LONG đã mở nếu có.');
            if (currentLongPosition) {
                // Đóng lệnh LONG đã mở, cần THÊM positionSide 'LONG'
                await closePosition(currentLongPosition.symbol, currentLongPosition.quantity, 'Lỗi mở lệnh SHORT', 'LONG');
                currentLongPosition = null; // Đảm bảo reset trạng thái
            }
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        addLog(`Đã mở thành công cả hai lệnh LONG và SHORT cho ${TARGET_COIN_SYMBOL}.`);

        // Đảm bảo positionCheckInterval được thiết lập nếu bot đang chạy
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && (currentLongPosition || currentShortPosition)) {
                    try {
                        await manageOpenPosition();
                    }
                    catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                        if(error instanceof CriticalApiError) {
                            addLog(`Bot dừng do lỗi API trong kiểm tra vị thế.`);
                            stopBotLogicInternal();
                            if (!retryBotTimeout) {
                                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('Thử khởi động lại bot...');
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, ERROR_RETRY_DELAY_MS);
                            }
                        }
                    }
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 5000); // Tăng lên 5 giây
        }

        // Sửa đổi 2: chỉnh sau khi đặt lệnh 3s cài tp sl ban đầu, sau 15s kiểm tra lại nếu 2 vị thế còn thiếu tp sl ban đầu thì thêm lại
        // Logic ban đầu đã đặt TP/SL sau 3s. Bây giờ sẽ kiểm tra lại sau 15s.
        setTimeout(async () => {
            if (botRunning) {
                addLog('Kiểm tra lại trạng thái lệnh TP/SL sau 15 giây...');
                if (currentLongPosition) {
                    await checkAndRecreateTPAndSL(currentLongPosition);
                }
                if (currentShortPosition) {
                    await checkAndRecreateTPAndSL(currentShortPosition);
                }
            }
        }, 15000); // Đợi 15 giây sau khi mở lệnh ban đầu

    } catch (error) {
        addLog(`Lỗi trong chu kỳ giao dịch chính: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng.`);
            stopBotLogicInternal();
        } else {
            addLog(`Đợi 2 giây trước khi lên lịch chu kỳ mới sau lỗi trong runTradingLogic.`);
            await sleep(2000);
            if(botRunning) scheduleNextMainCycle();
        }
    }
}


// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đang chạy.');
        return 'Bot đang chạy.';
    }

    // Đảm bảo API_KEY và SECRET_KEY được sử dụng từ config.js
    if (!API_KEY || !SECRET_KEY) {
        addLog('Lỗi: API Key hoặc Secret Key chưa được cấu hình. Vui lòng kiểm tra file config.js.');
        // Dừng luôn nếu không có key
        return 'Lỗi: API Key hoặc Secret Key chưa được cấu hình. Vui lòng kiểm tra file config.js.';
    }

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.');
    }

    addLog('--- Khởi động Bot ---');
    addLog('Kiểm tra kết nối API Binance Futures...');

    try {
        await syncServerTime();

        // Kiểm tra vị thế trên sàn
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

        currentLongPosition = null;
        currentShortPosition = null;

        if (positionsOnBinance.length > 0) {
            addLog(`Tìm thấy vị thế đang mở cho ${TARGET_COIN_SYMBOL}. Bot sẽ tiếp tục theo dõi các vị thế này.`);

            // Lấy đòn bẩy đã sử dụng từ chính vị thế nếu có, hoặc từ API nếu không có
            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) {
                 addLog(`Không thể lấy đòn bẩy khi khởi động lại. Dừng khởi động.`);
                 throw new Error("Không thể lấy đòn bẩy khi khởi động lại.");
            }

            let partialCloseSteps = [];
            let partialCloseLossSteps = [];
            if (maxLeverage >= 75) {
                for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 100);
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100);
            } else if (maxLeverage === 50) {
                for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 50);
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50);
            } else if (maxLeverage < 50) { // Đòn bẩy dưới 50 (bao gồm x25)
                for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 35);
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35);
            } else {
                for (let i = 1; i <= 9; i++) partialCloseSteps.push(i * 35); // Default
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); // Default
            }

            for (const pos of positionsOnBinance) {
                // Sử dụng pos.positionSide trực tiếp từ API Binance
                const positionSide = pos.positionSide;
                const symbolInfo = await getSymbolDetails(TARGET_COIN_SYMBOL);
                const pricePrecision = symbolInfo ? symbolInfo.pricePrecision : 8; // Fallback nếu không lấy được info

                const recoveredPosition = {
                    symbol: TARGET_COIN_SYMBOL,
                    quantity: Math.abs(parseFloat(pos.positionAmt)),
                    initialQuantity: Math.abs(parseFloat(pos.positionAmt)), // Khôi phục initialQuantity từ số lượng hiện tại trên sàn
                    entryPrice: parseFloat(pos.entryPrice),
                    initialTPPrice: 0, // Sẽ được cập nhật từ lệnh mở nếu tìm thấy
                    initialSLPrice: 0, // Sẽ được cập nhật từ lệnh mở nếu tìm thấy
                    initialMargin: INITIAL_INVESTMENT_AMOUNT, // Rất quan trọng: Giả định initialMargin là INITIAL_INVESTMENT_AMOUNT ban đầu. Cần cơ chế khôi phục phức tạp hơn nếu bot có thể thay đổi initialInvestmentAmount giữa các chu kỳ.
                    openTime: new Date(parseFloat(pos.updateTime)),
                    pricePrecision: pricePrecision,
                    side: positionSide, // Gán trực tiếp positionSide của vị thế
                    unrealizedPnl: parseFloat(pos.unRealizedProfit),
                    currentPrice: parseFloat(pos.markPrice),
                    currentTPId: null, // Cần lấy lại từ open orders
                    currentSLId: null, // Cần lấy lại từ open orders
                    closedAmount: 0, // KHI KHỞI ĐỘNG LẠI, CLOSED_AMOUNT VÀ NEXT_PARTIAL_CLOSE_INDEX ĐƯỢC RESET VỀ 0. CẦN LƯU VÀO DB ĐỂ KHÔI PHỤC CHÍNH XÁC.
                    partialCloseLevels: partialCloseSteps,
                    nextPartialCloseIndex: 0, // KHI KHỞI ĐỘNG LẠI, CLOSED_AMOUNT VÀ NEXT_PARTIAL_CLOSE_INDEX ĐƯỢC RESET VỀ 0. CẦN LƯU VÀO DB ĐỂ KHÔI PHỤC CHÍNH XÁC.
                    closedLossAmount: 0, // Reset khi khởi động lại
                    partialCloseLossLevels: partialCloseLossSteps,
                    nextPartialCloseLossIndex: 0, // Reset khi khởi động lại
                    hasAdjustedSLTo200PercentProfit: false, // Reset cờ điều chỉnh SL khi khởi động lại
                    hasAdjustedSLTo500PercentProfit: false, // Reset cờ điều chỉnh SL khi khởi động lại
                    maxLeverageUsed: maxLeverage, // Lưu đòn bẩy đã sử dụng
                };

                if (positionSide === 'LONG') {
                    currentLongPosition = recoveredPosition;
                } else if (positionSide === 'SHORT') {
                    currentShortPosition = recoveredPosition;
                }
            }

            // Cố gắng khôi phục OrderId và giá của TP/SL nếu có
            const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: TARGET_COIN_SYMBOL });
            for (const order of openOrders) {
                if (order.symbol === TARGET_COIN_SYMBOL && order.status === 'NEW') {
                    if (order.type === 'TAKE_PROFIT_MARKET') {
                        if (order.positionSide === 'LONG' && currentLongPosition) {
                            currentLongPosition.currentTPId = order.orderId;
                            currentLongPosition.initialTPPrice = parseFloat(order.stopPrice);
                        }
                        if (order.positionSide === 'SHORT' && currentShortPosition) {
                            currentShortPosition.currentTPId = order.orderId;
                            currentShortPosition.initialTPPrice = parseFloat(order.stopPrice);
                        }
                    } else if (order.type === 'STOP_MARKET') {
                        if (order.positionSide === 'LONG' && currentLongPosition) {
                            currentLongPosition.currentSLId = order.orderId;
                            currentLongPosition.initialSLPrice = parseFloat(order.stopPrice);
                        }
                        if (order.positionSide === 'SHORT' && currentShortPosition) {
                            currentShortPosition.currentSLId = order.orderId;
                            currentShortPosition.initialSLPrice = parseFloat(order.stopPrice);
                        }
                    }
                }
            }
        }

        const usdtAsset = (await callSignedAPI('/fapi/v2/account', 'GET')).assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtAsset).toFixed(2)}`);

        consecutiveApiErrors = 0;

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('Lỗi tải exchangeInfo. Bot dừng.');
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        listenKey = await getListenKey();
        if (listenKey) {
            setupUserDataStream(listenKey);
        } else {
            addLog("Không thể khởi tạo User Data Stream. Bot sẽ tiếp tục nhưng có thể thiếu thông tin cập nhật PNL.");
        }

        setupMarketDataStream(TARGET_COIN_SYMBOL);

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Đồng coin giao dịch: ${TARGET_COIN_SYMBOL}`);
        addLog(`Vốn ban đầu cho mỗi lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);

        // Chỉ chạy chu kỳ chính sau khi tất cả khởi tạo xong
        // Nếu đã có vị thế mở, runTradingLogic sẽ bỏ qua và chỉ bắt đầu chu kỳ mới khi tất cả vị thế đóng
        scheduleNextMainCycle();

        // Đảm bảo positionCheckInterval được thiết lập nếu bot đang chạy hoặc có vị thế mở
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && (currentLongPosition || currentShortPosition)) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                        if(error instanceof CriticalApiError) {
                            addLog(`Bot dừng do lỗi API trong kiểm tra vị thế.`);
                            stopBotLogicInternal();
                            if (!retryBotTimeout) {
                                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('Thử khởi động lại bot...');
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, ERROR_RETRY_DELAY_MS);
                            }
                        }
                    }
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 5000);
        }

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('[Lỗi khởi động bot] ' + errorMsg);
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.');

        stopBotLogicInternal();
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => {
                addLog('Thử khởi động lại bot...');
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot không chạy.');
        return 'Bot không chạy.';
    }
    botRunning = false;
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    if (marketWs) {
        marketWs.close();
        marketWs = null;
    }
    if (userDataWs) {
        userDataWs.close();
        userDataWs = null;
    }
    if (listenKeyRefreshInterval) {
        clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
    }
    listenKey = null;
    currentMarketPrice = null;

    consecutiveApiErrors = 0;
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.');
    }
    addLog('--- Bot đã dừng ---');
    botStartTime = null;

    // Reset trạng thái vị thế khi dừng bot
    currentLongPosition = null;
    currentShortPosition = null;
    totalProfit = 0;
    totalLoss = 0;
    netPNL = 0;

    return 'Bot đã dừng.';
}

// Hàm bổ sung để xử lý vị thế sót lại sau khi bot dừng hoặc có lỗi
async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Đang kiểm tra vị thế còn sót lại cho ${symbol} sau khi một chu kỳ hoàn tất.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế còn sót lại cho ${symbol}. Đang đóng...`);
            for (const pos of remainingPositions) {
                // Gọi closePosition với positionSide cụ thể
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                await closePosition(pos.symbol, Math.abs(parseFloat(pos.positionAmt)), `Vị thế ${pos.symbol} còn sót lại (${parseFloat(pos.positionAmt)}).`, sideToClose);
            }
        } else {
            addLog(`Không có vị thế ${symbol} nào còn sót lại.`);
        }
    } catch (error) {
        addLog(`Lỗi khi kiểm tra và đóng vị thế sót lại cho ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi xử lý vị thế sót.`);
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
                initialQuantity: currentLongPosition.initialQuantity, // Thêm initialQuantity vào API response
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
                initialQuantity: currentShortPosition.initialQuantity, // Thêm initialQuantity vào API response
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

        // Nếu symbol thay đổi, reset các biến liên quan đến trạng thái giao dịch
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
