
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
            addLog("  -> Kiểm tra API Key/Secret và quyền Futures.");
        } else if (error.code === -1021) {
            addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính.");
        } else if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API!");
        } else if (error.code === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số.");
        } else if (error.code === -4061) {
            addLog("  -> Lỗi -4061 (Order's position side does not match user's setting). Đảm bảo đã bật Hedge Mode và lệnh có positionSide phù hợp.");
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
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
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API!");
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
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

        addLog(`Gửi lệnh đóng từng phần: ${position.symbol}, Side: ${closeSide}, PositionSide: ${position.side}, Type: MARKET, Qty: ${quantityToClose.toFixed(quantityPrecision)}`);

        // Gửi lệnh market để đóng từng phần
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: closeSide,
            positionSide: position.side, // Quan trọng: chỉ định positionSide
            type: 'MARKET',
            quantity: quantityToClose.toFixed(quantityPrecision), // Đảm bảo số lượng đã được làm tròn đúng
            // reduceOnly: 'true' // KHÔNG DÙNG reduceOnly trong Hedge Mode cho lệnh market.
        });

        // Cập nhật trạng thái `closedAmount` và `nextPartialCloseLossIndex`
        if (type === 'LOSS') {
            position.closedLossAmount += quantityToClose;
            position.nextPartialCloseLossIndex++;
            addLog(`Đã đóng thành công ${quantityToClose.toFixed(quantityPrecision)} của lệnh ${position.side} ${position.symbol} (lỗ). Tổng đã đóng: ${position.closedLossAmount.toFixed(quantityPrecision)}.`);
        } else { // type === 'PROFIT'
            position.closedAmount += quantityToClose;
            position.nextPartialCloseIndex++;
            addLog(`Đã đóng thành công ${quantityToClose.toFixed(quantityPrecision)} của lệnh ${position.side} ${position.symbol} (lãi). Tổng đã đóng: ${position.closedAmount.toFixed(quantityPrecision)}.`);
        }
        await sleep(500); // Đợi một chút để lệnh khớp
    } catch (error) {
        addLog(`Lỗi đóng từng phần vị thế ${position.side} ${position.symbol}: ${error.msg || error.message}`);
        if (error.code === -2011) {
            addLog(`Vị thế ${position.side} ${position.symbol} không tồn tại hoặc đã đóng hoàn toàn.`);
        }
    }
}

/**
 * Kiểm tra các lệnh mở trên Binance và cập nhật trạng thái của bot.
 * Hàm này cũng sẽ xử lý việc hủy bỏ các lệnh TP/SL cũ nếu chúng không còn liên quan.
 * @param {string} symbol - Mã giao dịch.
 */
async function updateOpenOrdersState(symbol) {
    try {
        const openOrders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: symbol });

        // Cập nhật currentLongPosition
        if (currentLongPosition) {
            const longTPOrder = openOrders.find(o => o.orderId === currentLongPosition.currentTPId && o.positionSide === 'LONG');
            if (!longTPOrder) {
                addLog(`Cảnh báo: Lệnh TP Long (${currentLongPosition.currentTPId}) không còn trên sàn. Có thể đã khớp hoặc bị hủy.`);
                currentLongPosition.currentTPId = null; // Đặt về null
            }
            const longSLOrder = openOrders.find(o => o.orderId === currentLongPosition.currentSLId && o.positionSide === 'LONG');
            if (!longSLOrder) {
                addLog(`Cảnh báo: Lệnh SL Long (${currentLongPosition.currentSLId}) không còn trên sàn. Có thể đã khớp hoặc bị hủy.`);
                currentLongPosition.currentSLId = null; // Đặt về null
            }
        }

        // Cập nhật currentShortPosition
        if (currentShortPosition) {
            const shortTPOrder = openOrders.find(o => o.orderId === currentShortPosition.currentTPId && o.positionSide === 'SHORT');
            if (!shortTPOrder) {
                addLog(`Cảnh báo: Lệnh TP Short (${currentShortPosition.currentTPId}) không còn trên sàn. Có thể đã khớp hoặc bị hủy.`);
                currentShortPosition.currentTPId = null; // Đặt về null
            }
            const shortSLOrder = openOrders.find(o => o.orderId === currentShortPosition.currentSLId && o.positionSide === 'SHORT');
            if (!shortSLOrder) {
                addLog(`Cảnh báo: Lệnh SL Short (${currentShortPosition.currentSLId}) không còn trên sàn. Có thể đã khớp hoặc bị hủy.`);
                currentShortPosition.currentSLId = null; // Đặt về null
            }
        }
    } catch (error) {
        addLog(`Lỗi cập nhật trạng thái lệnh mở: ${error.msg || error.message}`);
    }
}

async function placeTP_SL_Orders(position, tpPrice, slPrice, positionSide) {
    const symbol = position.symbol;
    const quantity = parseFloat(Math.abs(position.quantity).toFixed(position.quantityPrecision));
    const pricePrecision = position.pricePrecision;

    if (quantity <= 0) {
        addLog(`Số lượng vị thế (${quantity}) không hợp lệ cho lệnh TP/SL ${positionSide} ${symbol}.`);
        return;
    }

    addLog(`Đang đặt lệnh TP/SL cho ${positionSide} ${symbol} với Qty: ${quantity.toFixed(position.quantityPrecision)}, TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

    try {
        // Hủy các lệnh TP/SL cũ nếu có
        await cancelOpenOrdersForSymbol(symbol, position.currentTPId, positionSide);
        await cancelOpenOrdersForSymbol(symbol, position.currentSLId, positionSide);

        // Đặt lệnh TP
        const tpSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
        const tpOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: tpSide,
            positionSide: positionSide,
            type: 'TAKE_PROFIT_MARKET',
            quantity: quantity,
            stopPrice: tpPrice.toFixed(pricePrecision),
            newClientOrderId: `TP_${symbol}_${positionSide}_${Date.now()}`,
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE',
            closePosition: 'true' // Đảm bảo đóng toàn bộ vị thế
        });
        position.currentTPId = tpOrder.orderId;
        addLog(`✅ Đã đặt lệnh TP ${tpSide} cho ${symbol} (${positionSide}): OrderId: ${tpOrder.orderId}, StopPrice: ${tpPrice.toFixed(pricePrecision)}`);

        // Đặt lệnh SL
        const slSide = positionSide === 'LONG' ? 'SELL' : 'BUY';
        const slOrder = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: slSide,
            positionSide: positionSide,
            type: 'STOP_MARKET',
            quantity: quantity,
            stopPrice: slPrice.toFixed(pricePrecision),
            newClientOrderId: `SL_${symbol}_${positionSide}_${Date.now()}`,
            timeInForce: 'GTC',
            workingType: 'MARK_PRICE',
            closePosition: 'true' // Đảm bảo đóng toàn bộ vị thế
        });
        position.currentSLId = slOrder.orderId;
        addLog(`✅ Đã đặt lệnh SL ${slSide} cho ${symbol} (${positionSide}): OrderId: ${slOrder.orderId}, StopPrice: ${slPrice.toFixed(pricePrecision)}`);

    } catch (error) {
        addLog(`❌ Lỗi đặt lệnh TP/SL cho ${positionSide} ${symbol}: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        // Nếu có lỗi, đảm bảo các orderId không còn được tham chiếu
        position.currentTPId = null;
        position.currentSLId = null;
        if (error.code === -2011) {
            addLog(`Lỗi -2011 khi đặt TP/SL. Có thể vị thế đã bị đóng hoặc khối lượng không hợp lệ. Khối lượng: ${quantity}.`);
        } else if (error.code === -4061) {
            addLog(`Lỗi -4061 (Order's position side does not match user's setting) khi đặt TP/SL. Kiểm tra chế độ hedging.`);
        }
    }
}

// Hàm sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- LOGIC GIAO DỊCH CHÍNH ---

/**
 * Kiểm tra và xử lý các vị thế đang mở trên Binance.
 * Cập nhật trạng thái `currentLongPosition` và `currentShortPosition` của bot.
 * Nếu phát hiện vị thế đã đóng hoàn toàn, sẽ kích hoạt lại chu kỳ chính.
 */
async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Đang kiểm tra các vị thế còn lại cho ${symbol} trên sàn.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const longPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === 'LONG' && parseFloat(p.positionAmt) !== 0);
        const shortPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) !== 0);

        // Xử lý vị thế LONG
        if (!longPositionOnBinance || parseFloat(longPositionOnBinance.positionAmt) === 0) {
            if (currentLongPosition) {
                addLog(`✅ Vị thế LONG cho ${symbol} đã đóng trên sàn. Cập nhật trạng thái bot.`);
                currentLongPosition = null;
                // Nếu longPosition đã đóng và shortPosition cũng đóng, kích hoạt chu kỳ mới
                if (!currentShortPosition) {
                    addLog(`Cả hai vị thế LONG và SHORT cho ${symbol} đã đóng. Kích hoạt chu kỳ mới.`);
                    await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); // Hủy hết lệnh cũ
                    if (botRunning) scheduleNextMainCycle();
                }
            } else {
                // addLog(`Không có vị thế LONG ${symbol} nào trên sàn.`); // Log này quá nhiều, bỏ qua
            }
        } else {
            // Nếu có vị thế LONG trên Binance nhưng bot không theo dõi, cần đồng bộ
            if (!currentLongPosition) {
                addLog(`Phát hiện vị thế LONG ${symbol} trên sàn nhưng bot không theo dõi. Đồng bộ trạng thái.`);
                const symbolDetails = await getSymbolDetails(symbol);
                if (symbolDetails) {
                    currentLongPosition = {
                        symbol: symbol,
                        quantity: parseFloat(longPositionOnBinance.positionAmt),
                        entryPrice: parseFloat(longPositionOnBinance.entryPrice),
                        initialTPPrice: 0, // Cần tính toán lại hoặc bỏ qua TP/SL tự động cho vị thế này
                        initialSLPrice: 0,
                        initialMargin: parseFloat(longPositionOnBinance.initialMargin),
                        openTime: Date.now(), // Hoặc lấy từ API nếu có
                        pricePrecision: symbolDetails.pricePrecision,
                        quantityPrecision: symbolDetails.quantityPrecision,
                        side: 'LONG',
                        currentPrice: currentMarketPrice,
                        unrealizedPnl: parseFloat(longPositionOnBinance.unrealizedPnl),
                        currentTPId: null, // Cần kiểm tra lệnh TP/SL liên quan nếu có
                        currentSLId: null,
                        closedAmount: 0,
                        partialCloseLevels: [],
                        nextPartialCloseIndex: 0,
                        hasAdjustedSLTo200PercentProfit: false,
                        hasAdjustedSLTo500PercentProfit: false,
                        maxLeverageUsed: parseInt(longPositionOnBinance.leverage), // Cập nhật đòn bẩy
                        closedLossAmount: 0,
                        partialCloseLossLevels: [],
                        nextPartialCloseLossIndex: 0,
                        initialQuantity: parseFloat(longPositionOnBinance.positionAmt) // Số lượng ban đầu
                    };
                    addLog(`Đã đồng bộ vị thế LONG ${symbol} từ sàn. Vui lòng kiểm tra và xử lý thủ công hoặc đợi chu kỳ mới.`);
                    // Hủy các lệnh đang chờ để tránh xung đột
                    await cancelOpenOrdersForSymbol(symbol, null, 'LONG');
                } else {
                    addLog(`Không thể lấy chi tiết symbol cho ${symbol} khi đồng bộ vị thế LONG.`);
                }
            } else {
                // Cập nhật thông tin vị thế LONG từ Binance
                currentLongPosition.quantity = parseFloat(longPositionOnBinance.positionAmt);
                currentLongPosition.entryPrice = parseFloat(longPositionOnBinance.entryPrice);
                currentLongPosition.unrealizedPnl = parseFloat(longPositionOnBinance.unrealizedPnl);
                currentLongPosition.maxLeverageUsed = parseInt(longPositionOnBinance.leverage);
                // addLog(`Đã cập nhật trạng thái vị thế LONG ${symbol}.`); // Log này quá nhiều, bỏ qua
            }
        }

        // Xử lý vị thế SHORT
        if (!shortPositionOnBinance || parseFloat(shortPositionOnBinance.positionAmt) === 0) {
            if (currentShortPosition) {
                addLog(`✅ Vị thế SHORT cho ${symbol} đã đóng trên sàn. Cập nhật trạng thái bot.`);
                currentShortPosition = null;
                // Nếu shortPosition đã đóng và longPosition cũng đóng, kích hoạt chu kỳ mới
                if (!currentLongPosition) {
                    addLog(`Cả hai vị thế LONG và SHORT cho ${symbol} đã đóng. Kích hoạt chu kỳ mới.`);
                    await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); // Hủy hết lệnh cũ
                    if (botRunning) scheduleNextMainCycle();
                }
            } else {
                // addLog(`Không có vị thế SHORT ${symbol} nào trên sàn.`); // Log này quá nhiều, bỏ qua
            }
        } else {
            // Nếu có vị thế SHORT trên Binance nhưng bot không theo dõi, cần đồng bộ
            if (!currentShortPosition) {
                addLog(`Phát hiện vị thế SHORT ${symbol} trên sàn nhưng bot không theo dõi. Đồng bộ trạng thái.`);
                const symbolDetails = await getSymbolDetails(symbol);
                if (symbolDetails) {
                    currentShortPosition = {
                        symbol: symbol,
                        quantity: parseFloat(shortPositionOnBinance.positionAmt),
                        entryPrice: parseFloat(shortPositionOnBinance.entryPrice),
                        initialTPPrice: 0, // Cần tính toán lại hoặc bỏ qua TP/SL tự động cho vị thế này
                        initialSLPrice: 0,
                        initialMargin: parseFloat(shortPositionOnBinance.initialMargin),
                        openTime: Date.now(),
                        pricePrecision: symbolDetails.pricePrecision,
                        quantityPrecision: symbolDetails.quantityPrecision,
                        side: 'SHORT',
                        currentPrice: currentMarketPrice,
                        unrealizedPnl: parseFloat(shortPositionOnBinance.unrealizedPnl),
                        currentTPId: null,
                        currentSLId: null,
                        closedAmount: 0,
                        partialCloseLevels: [],
                        nextPartialCloseIndex: 0,
                        hasAdjustedSLTo200PercentProfit: false,
                        hasAdjustedSLTo500PercentProfit: false,
                        maxLeverageUsed: parseInt(shortPositionOnBinance.leverage),
                        closedLossAmount: 0,
                        partialCloseLossLevels: [],
                        nextPartialCloseLossIndex: 0,
                        initialQuantity: Math.abs(parseFloat(shortPositionOnBinance.positionAmt)) // Số lượng ban đầu
                    };
                    addLog(`Đã đồng bộ vị thế SHORT ${symbol} từ sàn. Vui lòng kiểm tra và xử lý thủ công hoặc đợi chu kỳ mới.`);
                    // Hủy các lệnh đang chờ để tránh xung đột
                    await cancelOpenOrdersForSymbol(symbol, null, 'SHORT');
                } else {
                    addLog(`Không thể lấy chi tiết symbol cho ${symbol} khi đồng bộ vị thế SHORT.`);
                }
            } else {
                // Cập nhật thông tin vị thế SHORT từ Binance
                currentShortPosition.quantity = parseFloat(shortPositionOnBinance.positionAmt);
                currentShortPosition.entryPrice = parseFloat(shortPositionOnBinance.entryPrice);
                currentShortPosition.unrealizedPnl = parseFloat(shortPositionOnBinance.unrealizedPnl);
                currentShortPosition.maxLeverageUsed = parseInt(shortPositionOnBinance.leverage);
                // addLog(`Đã cập nhật trạng thái vị thế SHORT ${symbol}.`); // Log này quá nhiều, bỏ qua
            }
        }
    } catch (error) {
        addLog(`Lỗi khi kiểm tra vị thế còn lại: ${error.msg || error.message}`);
    }
}

/**
 * Điều chỉnh SL cho vị thế LONG khi đạt mức lãi 200% và 500%.
 * @param {object} position - Vị thế LONG hiện tại.
 */
async function adjustLongSLForProfit(position) {
    if (!position || position.side !== 'LONG' || !position.currentPrice || position.entryPrice <= 0) {
        return;
    }

    const profitPercentage = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const symbolInfo = await getSymbolDetails(position.symbol);
    if (!symbolInfo) {
        addLog(`Không thể lấy thông tin symbol cho ${position.symbol} để điều chỉnh SL.`);
        return;
    }
    const pricePrecision = symbolInfo.pricePrecision;
    const tickSize = symbolInfo.tickSize;

    // Tính toán lại SL mới
    // Lãi 200%: SL về giá Entry + 50%
    const sl200PercentProfitPrice = position.entryPrice + (position.entryPrice * 0.50);
    // Lãi 500%: SL về giá Entry + 100% (gấp đôi Entry)
    const sl500PercentProfitPrice = position.entryPrice * 2;

    if (profitPercentage >= 200 && !position.hasAdjustedSLTo200PercentProfit) {
        if (position.currentSLId) {
            addLog(`Đang hủy lệnh SL cũ (${position.currentSLId}) cho LONG ${position.symbol} để điều chỉnh SL.`);
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, 'LONG');
            position.currentSLId = null;
            await sleep(500);
        }

        const newSLPrice = Math.max(position.entryPrice, sl200PercentProfitPrice); // Đảm bảo SL không dưới giá Entry
        const adjustedSLPrice = Math.ceil(newSLPrice / tickSize) * tickSize; // Làm tròn lên theo tick size
        addLog(`📈 LONG ${position.symbol} đạt ${profitPercentage.toFixed(2)}% lãi. Điều chỉnh SL về ${adjustedSLPrice.toFixed(pricePrecision)} (Lãi 50% so với giá Entry).`);
        await placeTP_SL_Orders(position, position.initialTPPrice, adjustedSLPrice, 'LONG');
        position.hasAdjustedSLTo200PercentProfit = true;
    }

    if (profitPercentage >= 500 && !position.hasAdjustedSLTo500PercentProfit) {
        if (position.currentSLId) {
            addLog(`Đang hủy lệnh SL cũ (${position.currentSLId}) cho LONG ${position.symbol} để điều chỉnh SL.`);
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, 'LONG');
            position.currentSLId = null;
            await sleep(500);
        }

        const newSLPrice = Math.max(position.entryPrice, sl500PercentProfitPrice); // Đảm bảo SL không dưới giá Entry
        const adjustedSLPrice = Math.ceil(newSLPrice / tickSize) * tickSize; // Làm tròn lên theo tick size
        addLog(`🚀 LONG ${position.symbol} đạt ${profitPercentage.toFixed(2)}% lãi. Điều chỉnh SL về ${adjustedSLPrice.toFixed(pricePrecision)} (Lãi 100% so với giá Entry).`);
        await placeTP_SL_Orders(position, position.initialTPPrice, adjustedSLPrice, 'LONG');
        position.hasAdjustedSLTo500PercentProfit = true;
    }
}

/**
 * Điều chỉnh SL cho vị thế SHORT khi đạt mức lãi 200% và 500%.
 * @param {object} position - Vị thế SHORT hiện tại.
 */
async function adjustShortSLForProfit(position) {
    if (!position || position.side !== 'SHORT' || !position.currentPrice || position.entryPrice <= 0) {
        return;
    }

    // Đối với Short, lãi khi giá giảm.
    const profitPercentage = ((position.entryPrice - position.currentPrice) / position.entryPrice) * 100;
    const symbolInfo = await getSymbolDetails(position.symbol);
    if (!symbolInfo) {
        addLog(`Không thể lấy thông tin symbol cho ${position.symbol} để điều chỉnh SL.`);
        return;
    }
    const pricePrecision = symbolInfo.pricePrecision;
    const tickSize = symbolInfo.tickSize;

    // Tính toán lại SL mới
    // Lãi 200%: SL về giá Entry - 50%
    const sl200PercentProfitPrice = position.entryPrice - (position.entryPrice * 0.50);
    // Lãi 500%: SL về giá Entry - 100% (về 0, nhưng thực tế sẽ là một giá trị dương rất nhỏ)
    const sl500PercentProfitPrice = position.entryPrice * 0; // Về 0 nếu có thể. Thực tế sẽ là một giá trị gần 0 hoặc giá nhỏ nhất có thể.

    if (profitPercentage >= 200 && !position.hasAdjustedSLTo200PercentProfit) {
        if (position.currentSLId) {
            addLog(`Đang hủy lệnh SL cũ (${position.currentSLId}) cho SHORT ${position.symbol} để điều chỉnh SL.`);
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, 'SHORT');
            position.currentSLId = null;
            await sleep(500);
        }

        const newSLPrice = Math.min(position.entryPrice, sl200PercentProfitPrice); // Đảm bảo SL không trên giá Entry
        const adjustedSLPrice = Math.floor(newSLPrice / tickSize) * tickSize; // Làm tròn xuống theo tick size
        addLog(`📈 SHORT ${position.symbol} đạt ${profitPercentage.toFixed(2)}% lãi. Điều chỉnh SL về ${adjustedSLPrice.toFixed(pricePrecision)} (Lãi 50% so với giá Entry).`);
        await placeTP_SL_Orders(position, position.initialTPPrice, adjustedSLPrice, 'SHORT');
        position.hasAdjustedSLTo200PercentProfit = true;
    }

    if (profitPercentage >= 500 && !position.hasAdjustedSLTo500PercentProfit) {
        if (position.currentSLId) {
            addLog(`Đang hủy lệnh SL cũ (${position.currentSLId}) cho SHORT ${position.symbol} để điều chỉnh SL.`);
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, 'SHORT');
            position.currentSLId = null;
            await sleep(500);
        }

        const newSLPrice = Math.min(position.entryPrice, sl500PercentProfitPrice); // Đảm bảo SL không trên giá Entry
        const adjustedSLPrice = Math.floor(newSLPrice / tickSize) * tickSize; // Làm tròn xuống theo tick size
        addLog(`🚀 SHORT ${position.symbol} đạt ${profitPercentage.toFixed(2)}% lãi. Điều chỉnh SL về ${adjustedSLPrice.toFixed(pricePrecision)} (Lãi 100% so với giá Entry).`);
        await placeTP_SL_Orders(position, position.initialTPPrice, adjustedSLPrice, 'SHORT');
        position.hasAdjustedSLTo500PercentProfit = true;
    }
}

/**
 * Xử lý chính logic quản lý vị thế đang mở: cập nhật giá, tính PNL, điều chỉnh SL, đóng từng phần lỗ.
 */
async function manageOpenPosition() {
    if (!botRunning || (!currentLongPosition && !currentShortPosition)) {
        return; // Không có vị thế nào để quản lý hoặc bot không chạy
    }

    const symbol = TARGET_COIN_SYMBOL;
    const price = currentMarketPrice; // Lấy giá mới nhất từ WebSocket
    if (!price) {
        addLog(`Không có giá thị trường hiện tại cho ${symbol}. Bỏ qua quản lý vị thế.`);
        return;
    }

    // Cập nhật giá hiện tại cho cả hai vị thế
    if (currentLongPosition) {
        currentLongPosition.currentPrice = price;
        currentLongPosition.unrealizedPnl = (price - currentLongPosition.entryPrice) * currentLongPosition.quantity * currentLongPosition.maxLeverageUsed; // PNL ước tính
    }
    if (currentShortPosition) {
        currentShortPosition.currentPrice = price;
        currentShortPosition.unrealizedPnl = (currentShortPosition.entryPrice - price) * Math.abs(currentShortPosition.quantity) * currentShortPosition.maxLeverageUsed; // PNL ước tính (Short lãi khi giá giảm)
    }

    // --- Xử lý vị thế LONG ---
    if (currentLongPosition) {
        // Kiểm tra và cập nhật PNL thực tế từ sàn
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const longPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === 'LONG');
            if (longPositionOnBinance) {
                currentLongPosition.unrealizedPnl = parseFloat(longPositionOnBinance.unrealizedPnl);
                currentLongPosition.quantity = parseFloat(longPositionOnBinance.positionAmt); // Cập nhật số lượng thực tế
                currentLongPosition.entryPrice = parseFloat(longPositionOnBinance.entryPrice); // Cập nhật giá vào
                currentLongPosition.maxLeverageUsed = parseInt(longPositionOnBinance.leverage); // Cập nhật đòn bẩy
            } else {
                // Vị thế LONG đã đóng trên Binance nhưng bot chưa cập nhật
                addLog(`Cảnh báo: Vị thế LONG ${symbol} đã đóng trên Binance nhưng bot vẫn đang theo dõi. Đang cập nhật trạng thái.`);
                currentLongPosition = null;
                // Nếu một vị thế đã đóng, kích hoạt chu kỳ mới
                if (!currentShortPosition) { // Chỉ khi cả hai vị thế đã đóng
                    addLog(`Cả hai vị thế đã đóng sau khi phát hiện LONG đóng. Kích hoạt chu kỳ mới.`);
                    await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); // Hủy hết lệnh cũ
                    if (botRunning) scheduleNextMainCycle();
                }
                return; // Không xử lý tiếp vị thế này nữa
            }
        } catch (error) {
            addLog(`Lỗi khi lấy thông tin vị thế LONG từ sàn: ${error.msg || error.message}`);
            return;
        }

        const currentLongPNLPercentage = (currentLongPosition.unrealizedPnl / currentLongPosition.initialMargin) * 100;
        addLog(`LONG ${symbol} | Giá vào: ${currentLongPosition.entryPrice.toFixed(currentLongPosition.pricePrecision)} | Giá hiện tại: ${price.toFixed(currentLongPosition.pricePrecision)} | PNL: ${currentLongPosition.unrealizedPnl.toFixed(2)} USDT (${currentLongPNLPercentage.toFixed(2)}%)`);

        // Điều chỉnh SL khi lãi
        await adjustLongSLForProfit(currentLongPosition);

        // Xử lý đóng từng phần khi lỗ
        if (currentLongPNLPercentage < 0) { // Lỗ
            for (let i = currentLongPosition.nextPartialCloseLossIndex; i < currentLongPosition.partialCloseLossLevels.length; i++) {
                const lossLevel = currentLongPosition.partialCloseLossLevels[i];
                if (currentLongPNLPercentage <= lossLevel.percentage) {
                    await closePartialPosition(currentLongPosition, lossLevel.quantityPercentage, 'LOSS');
                    currentLongPosition.nextPartialCloseLossIndex = i + 1; // Cập nhật mốc tiếp theo
                    break; // Chỉ đóng một phần tại một thời điểm
                }
            }
        }
    }

    // --- Xử lý vị thế SHORT ---
    if (currentShortPosition) {
        // Kiểm tra và cập nhật PNL thực tế từ sàn
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const shortPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === 'SHORT');
            if (shortPositionOnBinance) {
                currentShortPosition.unrealizedPnl = parseFloat(shortPositionOnBinance.unrealizedPnl);
                currentShortPosition.quantity = parseFloat(shortPositionOnBinance.positionAmt); // Cập nhật số lượng thực tế
                currentShortPosition.entryPrice = parseFloat(shortPositionOnBinance.entryPrice); // Cập nhật giá vào
                currentShortPosition.maxLeverageUsed = parseInt(shortPositionOnBinance.leverage); // Cập nhật đòn bẩy
            } else {
                // Vị thế SHORT đã đóng trên Binance nhưng bot chưa cập nhật
                addLog(`Cảnh báo: Vị thế SHORT ${symbol} đã đóng trên Binance nhưng bot vẫn đang theo dõi. Đang cập nhật trạng thái.`);
                currentShortPosition = null;
                // Nếu một vị thế đã đóng, kích hoạt chu kỳ mới
                if (!currentLongPosition) { // Chỉ khi cả hai vị thế đã đóng
                    addLog(`Cả hai vị thế đã đóng sau khi phát hiện SHORT đóng. Kích hoạt chu kỳ mới.`);
                    await cancelOpenOrdersForSymbol(symbol, null, 'BOTH'); // Hủy hết lệnh cũ
                    if (botRunning) scheduleNextMainCycle();
                }
                return; // Không xử lý tiếp vị thế này nữa
            }
        } catch (error) {
            addLog(`Lỗi khi lấy thông tin vị thế SHORT từ sàn: ${error.msg || error.message}`);
            return;
        }

        const currentShortPNLPercentage = (currentShortPosition.unrealizedPnl / currentShortPosition.initialMargin) * 100;
        addLog(`SHORT ${symbol} | Giá vào: ${currentShortPosition.entryPrice.toFixed(currentShortPosition.pricePrecision)} | Giá hiện tại: ${price.toFixed(currentShortPosition.pricePrecision)} | PNL: ${currentShortPosition.unrealizedPnl.toFixed(2)} USDT (${currentShortPNLPercentage.toFixed(2)}%)`);

        // Điều chỉnh SL khi lãi
        await adjustShortSLForProfit(currentShortPosition);

        // Xử lý đóng từng phần khi lỗ
        if (currentShortPNLPercentage < 0) { // Lỗ
            for (let i = currentShortPosition.nextPartialCloseLossIndex; i < currentShortPosition.partialCloseLossLevels.length; i++) {
                const lossLevel = currentShortPosition.partialCloseLossLevels[i];
                if (currentShortPNLPercentage <= lossLevel.percentage) {
                    await closePartialPosition(currentShortPosition, lossLevel.quantityPercentage, 'LOSS');
                    currentShortPosition.nextPartialCloseLossIndex = i + 1; // Cập nhật mốc tiếp theo
                    break; // Chỉ đóng một phần tại một thời điểm
                }
            }
        }
    }
}

/**
 * Kiểm tra xem chế độ vị thế (Position Mode) trên tài khoản Binance có phải là Hedge Mode hay không.
 * Quan trọng: Bot này yêu cầu Hedge Mode.
 */
async function checkPositionMode() {
    try {
        const result = await callSignedAPI('/fapi/v1/positionSide/dual', 'GET');
        if (result && result.dualSidePosition === true) {
            addLog("✅ Chế độ vị thế: HEDGE MODE đã được bật.");
            return true;
        } else {
            addLog("❌ Chế độ vị thế: ONE-WAY MODE. Bot yêu cầu HEDGE MODE để hoạt động. Vui lòng bật HEDGE MODE trên Binance Futures!");
            return false;
        }
    } catch (error) {
        addLog(`Lỗi khi kiểm tra chế độ vị thế: ${error.msg || error.message}.`);
        return false;
    }
}

/**
 * Hàm chính chứa logic giao dịch của bot.
 * Sẽ được gọi lặp lại sau mỗi chu kỳ giao dịch.
 */
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot đã dừng. Không chạy logic giao dịch.');
        return;
    }
    addLog(`--- Bắt đầu chu kỳ giao dịch cho ${TARGET_COIN_SYMBOL} ---`);

    try {
        await syncServerTime();
        await getExchangeInfo();
        const symbolDetails = await getSymbolDetails(TARGET_COIN_SYMBOL);
        if (!symbolDetails) {
            throw new CriticalApiError(`Không thể lấy chi tiết symbol cho ${TARGET_COIN_SYMBOL}.`);
        }

        const price = await getCurrentPrice(TARGET_COIN_SYMBOL);
        if (!price) {
            throw new Error(`Không thể lấy giá hiện tại cho ${TARGET_COIN_SYMBOL}.`);
        }
        currentMarketPrice = price; // Cập nhật giá cache

        // Kiểm tra xem có vị thế nào đang mở không
        if (currentLongPosition || currentShortPosition) {
            addLog('Phát hiện có vị thế đang mở. Chuyển sang chế độ quản lý vị thế.');
            await manageOpenPosition();
        } else {
            addLog(`Không có vị thế đang mở cho ${TARGET_COIN_SYMBOL}. Đang chuẩn bị mở lệnh mới.`);

            // Lấy số dư USDT khả dụng
            const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
            const usdtBalance = accountInfo.assets.find(a => a.asset === 'USDT');
            if (!usdtBalance) {
                addLog('❌ Không tìm thấy số dư USDT trong tài khoản Futures của bạn.');
                throw new Error('Không có số dư USDT.');
            }
            const availableBalance = parseFloat(usdtBalance.availableBalance);
            addLog(`Số dư USDT khả dụng: ${availableBalance.toFixed(2)}`);

            if (availableBalance < INITIAL_INVESTMENT_AMOUNT) {
                addLog(`Số dư khả dụng (${availableBalance.toFixed(2)} USDT) thấp hơn số vốn đầu tư ban đầu (${INITIAL_INVESTMENT_AMOUNT} USDT). Không thể mở lệnh.`);
                return; // Dừng chu kỳ này nếu không đủ vốn
            }

            // Lấy đòn bẩy tối đa cho symbol
            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) {
                throw new Error(`Không thể lấy đòn bẩy tối đa cho ${TARGET_COIN_SYMBOL}.`);
            }

            // Đặt đòn bẩy (ví dụ: 10x)
            const desiredLeverage = 10;
            if (desiredLeverage > maxLeverage) {
                addLog(`Cảnh báo: Đòn bẩy mong muốn (${desiredLeverage}x) vượt quá đòn bẩy tối đa (${maxLeverage}x) cho ${TARGET_COIN_SYMBOL}. Đang sử dụng đòn bẩy tối đa.`);
                await setLeverage(TARGET_COIN_SYMBOL, maxLeverage);
            } else {
                await setLeverage(TARGET_COIN_SYMBOL, desiredLeverage);
            }

            const investmentUSDT = INITIAL_INVESTMENT_AMOUNT;
            // Tính toán số lượng dựa trên vốn đầu tư và đòn bẩy
            const quantity = parseFloat(((investmentUSDT * desiredLeverage) / price).toFixed(symbolDetails.quantityPrecision));

            if (quantity * price < symbolDetails.minNotional) {
                addLog(`Giá trị notional (${(quantity * price).toFixed(2)} USDT) quá nhỏ. Tăng INITIAL_INVESTMENT_AMOUNT hoặc giảm đòn bẩy.`);
                return;
            }

            if (quantity < symbolDetails.minQty) {
                addLog(`Số lượng tính toán (${quantity}) quá nhỏ. Tăng INITIAL_INVESTMENT_AMOUNT hoặc giảm đòn bẩy.`);
                return;
            }

            // Xác định ngẫu nhiên bên mua hoặc bán (LONG/SHORT)
            const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
            const positionSide = side === 'BUY' ? 'LONG' : 'SHORT'; // Đối với Hedge Mode

            addLog(`🚀 Đang mở lệnh ${side} ${TARGET_COIN_SYMBOL} với số lượng: ${quantity.toFixed(symbolDetails.quantityPrecision)}`);

            const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: TARGET_COIN_SYMBOL,
                side: side,
                positionSide: positionSide, // Quan trọng trong Hedge Mode
                type: 'MARKET',
                quantity: quantity.toFixed(symbolDetails.quantityPrecision),
                newClientOrderId: `OPEN_${TARGET_COIN_SYMBOL}_${positionSide}_${Date.now()}`
            });
            addLog(`✅ Đã mở lệnh ${side} ${TARGET_COIN_SYMBOL}. OrderId: ${orderResult.orderId}`);

            // Đợi một chút để lệnh khớp hoàn toàn và vị thế được ghi nhận
            await sleep(2000);

            // Cập nhật lại thông tin vị thế từ sàn sau khi mở lệnh
            const positionsAfterOpen = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const openedPosition = positionsAfterOpen.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

            if (openedPosition) {
                const entryPrice = parseFloat(openedPosition.entryPrice);
                const currentQuantity = Math.abs(parseFloat(openedPosition.positionAmt));
                const initialMargin = parseFloat(openedPosition.initialMargin);

                // Tính toán TP và SL
                const TP_PERCENTAGE = 0.5; // Lãi 50%
                const SL_PERCENTAGE = 0.2; // Lỗ 20%
                let tpPrice, slPrice;

                if (positionSide === 'LONG') {
                    tpPrice = entryPrice * (1 + TP_PERCENTAGE);
                    slPrice = entryPrice * (1 - SL_PERCENTAGE);
                } else { // SHORT
                    tpPrice = entryPrice * (1 - TP_PERCENTAGE);
                    slPrice = entryPrice * (1 + SL_PERCENTAGE);
                }

                // Làm tròn giá TP/SL theo precision của sàn
                const adjustedTPPrice = parseFloat(tpPrice.toFixed(symbolDetails.pricePrecision));
                const adjustedSLPrice = parseFloat(slPrice.toFixed(symbolDetails.pricePrecision));

                const partialCloseLossLevels = [
                    { percentage: -50, quantityPercentage: 5 }, // Đóng 5% khi lỗ 50%
                    { percentage: -100, quantityPercentage: 5 }, // Đóng 5% khi lỗ 100%
                ];

                const positionState = {
                    symbol: TARGET_COIN_SYMBOL,
                    quantity: currentQuantity,
                    entryPrice: entryPrice,
                    initialTPPrice: adjustedTPPrice,
                    initialSLPrice: adjustedSLPrice,
                    initialMargin: initialMargin,
                    openTime: Date.now(),
                    pricePrecision: symbolDetails.pricePrecision,
                    quantityPrecision: symbolDetails.quantityPrecision,
                    side: positionSide,
                    currentPrice: price,
                    unrealizedPnl: 0, // Sẽ được cập nhật từ WebSocket
                    currentTPId: null, // Sẽ được cập nhật sau khi đặt lệnh
                    currentSLId: null, // Sẽ được cập nhật sau khi đặt lệnh
                    closedAmount: 0,
                    partialCloseLevels: [], // Lãi không đóng từng phần
                    nextPartialCloseIndex: 0,
                    hasAdjustedSLTo200PercentProfit: false,
                    hasAdjustedSLTo500PercentProfit: false,
                    maxLeverageUsed: desiredLeverage,
                    closedLossAmount: 0,
                    partialCloseLossLevels: partialCloseLossLevels,
                    nextPartialCloseLossIndex: 0,
                    initialQuantity: quantity // Lưu trữ số lượng ban đầu để tính toán đóng từng phần
                };

                if (positionSide === 'LONG') {
                    currentLongPosition = positionState;
                } else {
                    currentShortPosition = positionState;
                }

                addLog(`Đã ghi nhận vị thế ${positionSide} của bot. Entry Price: ${entryPrice.toFixed(symbolDetails.pricePrecision)}, TP: ${adjustedTPPrice.toFixed(symbolDetails.pricePrecision)}, SL: ${adjustedSLPrice.toFixed(symbolDetails.pricePrecision)}`);

                // Đặt lệnh TP và SL sau khi đã mở vị thế
                await placeTP_SL_Orders(positionState, adjustedTPPrice, adjustedSLPrice, positionSide);

                // Khởi động lại vòng lặp kiểm tra vị thế nếu có vị thế mở
                startPositionCheckLoop();

            } else {
                addLog(`❌ Không tìm thấy vị thế ${positionSide} ${TARGET_COIN_SYMBOL} nào đang mở sau khi gửi lệnh. Có thể lệnh đã bị từ chối hoặc chưa khớp.`);
                // Cố gắng hủy bất kỳ lệnh nào còn sót nếu có lỗi
                await cancelOpenOrdersForSymbol(TARGET_COIN_SYMBOL, null, 'BOTH');
            }
        }
    } catch (error) {
        addLog(`Lỗi nghiêm trọng trong logic giao dịch chính: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng.`);
            stopBotLogicInternal();
        }
    } finally {
        addLog(`--- Kết thúc chu kỳ giao dịch cho ${TARGET_COIN_SYMBOL} ---`);
        if (botRunning && (!currentLongPosition && !currentShortPosition)) {
            // Chỉ scheduling lại nếu không có vị thế mở, để bắt đầu một chu kỳ mới
            // Nếu có vị thế mở, `manageOpenPosition` sẽ điều khiển việc lặp lại.
            scheduleNextMainCycle();
        } else if (botRunning && (currentLongPosition || currentShortPosition)) {
            // Nếu có vị thế mở, `manageOpenPosition` sẽ tiếp tục được gọi thông qua `positionCheckInterval`.
            // Không cần scheduleNextMainCycle ở đây.
        }
    }
}

// Hàm này sẽ lên lịch cho lần chạy tiếp theo của `runTradingLogic`
function scheduleNextMainCycle() {
    if (nextScheduledCycleTimeout) {
        clearTimeout(nextScheduledCycleTimeout);
    }
    const delay = 5000; // Đợi 5 giây trước khi bắt đầu chu kỳ mới nếu không có vị thế
    addLog(`Đang chờ ${delay / 1000} giây trước khi bắt đầu chu kỳ giao dịch tiếp theo.`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, delay);
}

// Khởi tạo vòng lặp kiểm tra vị thế khi có vị thế mở
function startPositionCheckLoop() {
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
    }
    addLog('Bắt đầu vòng lặp kiểm tra và quản lý vị thế (mỗi 5 giây).');
    positionCheckInterval = setInterval(async () => {
        if (botRunning && (currentLongPosition || currentShortPosition)) {
            await manageOpenPosition();
        } else {
            addLog('Không có vị thế đang mở, dừng vòng lặp kiểm tra vị thế.');
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            if (botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ chính để mở lệnh mới
        }
    }, 5000); // Kiểm tra mỗi 5 giây
}

// --- QUẢN LÝ WEBSOCKET ---

async function createListenKey() {
    try {
        const response = await callSignedAPI('/fapi/v1/listenKey', 'POST');
        listenKey = response.listenKey;
        addLog(`Đã tạo Listen Key: ${listenKey}`);
        // Refresh listen key mỗi 30 phút (thời gian sống là 60 phút)
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(refreshListenKey, 30 * 60 * 1000);
        return listenKey;
    } catch (error) {
        addLog(`Lỗi tạo Listen Key: ${error.msg || error.message}`);
        throw error;
    }
}

async function refreshListenKey() {
    if (!listenKey) {
        addLog("Không có Listen Key để làm mới.");
        return;
    }
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: listenKey });
        addLog(`Đã làm mới Listen Key: ${listenKey}`);
    } catch (error) {
        addLog(`Lỗi làm mới Listen Key: ${error.msg || error.message}`);
        // Nếu làm mới thất bại, có thể Listen Key đã hết hạn, cần tạo lại
        if (error.code === -1125 || error.code === -1000) { // Invalid Listen Key hoặc Unknown error (thường xảy ra khi key hết hạn)
            addLog("Listen Key có thể đã hết hạn. Đang cố gắng tạo Listen Key mới.");
            await createListenKey();
            connectUserDataWebSocket(); // Kết nối lại WebSocket với key mới
        }
    }
}

async function deleteListenKey() {
    if (!listenKey) return;
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'DELETE', { listenKey: listenKey });
        addLog(`Đã xóa Listen Key: ${listenKey}`);
    } catch (error) {
        addLog(`Lỗi xóa Listen Key: ${error.msg || error.message}`);
    } finally {
        if (listenKeyRefreshInterval) {
            clearInterval(listenKeyRefreshInterval);
            listenKeyRefreshInterval = null;
        }
        listenKey = null;
    }
}

function connectMarketWebSocket(symbol) {
    if (marketWs && marketWs.readyState === WebSocket.OPEN) {
        addLog(`Market WebSocket cho ${symbol} đã kết nối.`);
        return;
    }

    const wsPath = `/ws/${symbol.toLowerCase()}@markPrice`;
    const fullWsUrl = `${WS_BASE_URL}${wsPath}`;

    addLog(`Đang kết nối Market WebSocket tới: ${fullWsUrl}`);
    marketWs = new WebSocket(fullWsUrl);

    marketWs.onopen = () => {
        addLog(`✅ Đã kết nối Market WebSocket cho ${symbol}.`);
    };

    marketWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.e === 'markPriceUpdate') {
            currentMarketPrice = parseFloat(message.p);
            // addLog(`Giá ${symbol}: ${currentMarketPrice}`); // Log này quá nhiều, bỏ qua
        }
    };

    marketWs.onerror = (error) => {
        addLog(`❌ Lỗi Market WebSocket cho ${symbol}: ${error.message}`);
    };

    marketWs.onclose = (event) => {
        addLog(`Market WebSocket cho ${symbol} đã đóng. Code: ${event.code}, Reason: ${event.reason}`);
        if (botRunning) {
            addLog(`Đang cố gắng kết nối lại Market WebSocket cho ${symbol} sau 5 giây...`);
            setTimeout(() => connectMarketWebSocket(symbol), 5000);
        }
    };
}

function connectUserDataWebSocket() {
    if (userDataWs && userDataWs.readyState === WebSocket.OPEN) {
        addLog('User Data WebSocket đã kết nối.');
        return;
    }

    if (!listenKey) {
        addLog("Không có Listen Key. Không thể kết nối User Data WebSocket.");
        return;
    }

    const wsPath = `${WS_USER_DATA_ENDPOINT}/${listenKey}`;
    const fullWsUrl = `${WS_BASE_URL}${wsPath}`;

    addLog(`Đang kết nối User Data WebSocket tới: ${fullWsUrl}`);
    userDataWs = new WebSocket(fullWsUrl);

    userDataWs.onopen = () => {
        addLog('✅ Đã kết nối User Data WebSocket.');
    };

    userDataWs.onmessage = (event) => {
        const message = JSON.parse(event.data);
        // addLog(`User Data: ${JSON.stringify(message)}`); // Log quá nhiều, chỉ log những event quan trọng

        if (message.e === 'ACCOUNT_UPDATE') {
            // addLog('Cập nhật tài khoản:', message); // Có thể xử lý cập nhật số dư, PNL tổng, v.v.
        } else if (message.e === 'ORDER_TRADE_UPDATE') {
            // addLog(`Order Trade Update: ${JSON.stringify(message.o)}`);
            if (message.o.X === 'FILLED' || message.o.X === 'EXPIRED') {
                // Xử lý các lệnh đã khớp hoặc hết hạn
                if (parseFloat(message.o.rp) !== 0) { // Chỉ xử lý nếu có PNL thực tế
                    processTradeResult(message.o);
                } else {
                    addLog(`Lệnh ${message.o.i} (${message.o.S} ${message.o.q}) cho ${message.o.s} đã khớp nhưng PNL thực tế bằng 0. (Type: ${message.o.oT})`);
                }
            } else if (message.o.X === 'CANCELED') {
                addLog(`Lệnh ${message.o.i} cho ${message.o.s} đã bị HỦY.`);
            }
        }
    };

    userDataWs.onerror = (error) => {
        addLog(`❌ Lỗi User Data WebSocket: ${error.message}`);
    };

    userDataWs.onclose = (event) => {
        addLog(`User Data WebSocket đã đóng. Code: ${event.code}, Reason: ${event.reason}`);
        if (botRunning) {
            // Khi User Data Stream đóng, Listen Key có thể đã hết hạn hoặc bị hủy.
            // Cần tạo lại Listen Key và kết nối lại.
            addLog("User Data WebSocket bị đóng. Đang cố gắng tạo lại Listen Key và kết nối lại sau 5 giây...");
            deleteListenKey(); // Xóa key cũ trước
            setTimeout(async () => {
                try {
                    await createListenKey();
                    connectUserDataWebSocket();
                } catch (e) {
                    addLog(`Không thể tạo lại Listen Key và kết nối User Data WebSocket: ${e.message}`);
                    addLog(`Bot sẽ tiếp tục mà không có User Data Stream. Có thể bỏ lỡ các cập nhật PNL.`);
                }
            }, 5000);
        }
    };
}

// --- QUẢN LÝ TRẠNG THÁI BOT ---

// Hàm khởi động bot
async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đã và đang chạy.');
        return;
    }
    addLog('Đang khởi động bot...');
    botRunning = true;
    botStartTime = new Date();
    totalProfit = 0;
    totalLoss = 0;
    netPNL = 0;
    currentLongPosition = null;
    currentShortPosition = null;
    isClosingPosition = false; // Reset cờ

    try {
        await syncServerTime();
        const isHedgeMode = await checkPositionMode();
        if (!isHedgeMode) {
            addLog("Không thể khởi động bot vì Hedge Mode chưa được bật. Vui lòng bật Hedge Mode trên Binance Futures.");
            botRunning = false;
            return;
        }

        await getExchangeInfo(); // Cache exchange info khi khởi động
        connectMarketWebSocket(TARGET_COIN_SYMBOL); // Bắt đầu Market Data Stream
        await createListenKey();
        connectUserDataWebSocket(); // Bắt đầu User Data Stream

        // Kiểm tra và xử lý các vị thế đang mở trên sàn khi bot khởi động
        addLog(`Kiểm tra các vị thế đang mở cho ${TARGET_COIN_SYMBOL} khi khởi động.`);
        await checkAndHandleRemainingPosition(TARGET_COIN_SYMBOL);

        // Bắt đầu chu kỳ giao dịch chính
        addLog(`Bot đã khởi động thành công vào lúc ${formatTimeUTC7(botStartTime)}.`);
        // Nếu không có vị thế mở, bắt đầu chu kỳ chính để mở lệnh mới
        if (!currentLongPosition && !currentShortPosition) {
            scheduleNextMainCycle();
        } else {
            // Nếu có vị thế mở, bắt đầu vòng lặp kiểm tra vị thế để quản lý
            startPositionCheckLoop();
        }

    } catch (error) {
        addLog(`❌ Lỗi khởi động bot: ${error.message}`);
        // Nếu có lỗi nghiêm trọng khi khởi động, cố gắng khởi động lại sau một thời gian
        if (error instanceof CriticalApiError) {
            addLog(`Lỗi khởi động nghiêm trọng, sẽ thử lại sau ${ERROR_RETRY_DELAY_MS / 1000} giây.`);
            if (retryBotTimeout) clearTimeout(retryBotTimeout);
            retryBotTimeout = setTimeout(startBotLogicInternal, ERROR_RETRY_DELAY_MS);
        }
        botRunning = false; // Đảm bảo cờ botRunning được đặt lại
    }
}

// Hàm dừng bot
async function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot đã dừng hoặc không chạy.');
        return;
    }
    addLog('Đang dừng bot...');
    botRunning = false;
    botStartTime = null;

    // Dọn dẹp tất cả các interval và timeout
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    if (nextScheduledCycleTimeout) {
        clearTimeout(nextScheduledCycleTimeout);
        nextScheduledCycleTimeout = null;
    }
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
    }

    // Đóng và dọn dẹp WebSockets
    if (marketWs) {
        marketWs.close();
        marketWs = null;
    }
    if (userDataWs) {
        userDataWs.close();
        userDataWs = null;
    }
    await deleteListenKey(); // Xóa Listen Key khi dừng bot

    // Hủy tất cả các lệnh đang chờ trên sàn
    if (TARGET_COIN_SYMBOL) {
        addLog(`Đang hủy tất cả lệnh chờ cho ${TARGET_COIN_SYMBOL}.`);
        await cancelOpenOrdersForSymbol(TARGET_COIN_SYMBOL, null, 'BOTH');
    }

    // Đặt lại trạng thái vị thế của bot
    currentLongPosition = null;
    currentShortPosition = null;
    isClosingPosition = false;

    addLog('Bot đã dừng hoàn toàn.');
}

// --- WEB SERVER CHO UI ---

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Phục vụ các file tĩnh từ thư mục public

// Endpoint để lấy trạng thái bot
app.get('/status', async (req, res) => {
    let statusMessage = botRunning ? 'Đang chạy' : 'Đã dừng';
    let uptime = 'N/A';
    if (botStartTime) {
        const now = new Date();
        const diffMs = now.getTime() - botStartTime.getTime();
        const diffSeconds = Math.floor(diffMs / 1000);
        const hours = Math.floor(diffSeconds / 3600);
        const minutes = Math.floor((diffSeconds % 3600) / 60);
        const seconds = diffSeconds % 60;
        uptime = `${hours}h ${minutes}m ${seconds}s`;
    }

    let positionsDisplay = [];
    if (currentLongPosition) {
        positionsDisplay.push({
            side: currentLongPosition.side,
            symbol: currentLongPosition.symbol,
            quantity: currentLongPosition.quantity.toFixed(currentLongPosition.quantityPrecision),
            entryPrice: currentLongPosition.entryPrice.toFixed(currentLongPosition.pricePrecision),
            currentPrice: currentLongPosition.currentPrice ? currentLongPosition.currentPrice.toFixed(currentLongPosition.pricePrecision) : 'N/A',
            unrealizedPnl: currentLongPosition.unrealizedPnl !== undefined ? currentLongPosition.unrealizedPnl.toFixed(2) : 'N/A',
            initialQuantity: currentLongPosition.initialQuantity ? currentLongPosition.initialQuantity.toFixed(currentLongPosition.quantityPrecision) : 'N/A',
            closedAmount: currentLongPosition.closedLossAmount.toFixed(currentLongPosition.quantityPrecision), // Hiện tổng số lượng đã đóng lỗ
            nextPartialCloseLossIndex: currentLongPosition.nextPartialCloseLossIndex,
            currentTPId: currentLongPosition.currentTPId || 'N/A',
            currentSLId: currentLongPosition.currentSLId || 'N/A',
        });
    }
    if (currentShortPosition) {
        positionsDisplay.push({
            side: currentShortPosition.side,
            symbol: currentShortPosition.symbol,
            quantity: Math.abs(currentShortPosition.quantity).toFixed(currentShortPosition.quantityPrecision),
            entryPrice: currentShortPosition.entryPrice.toFixed(currentShortPosition.pricePrecision),
            currentPrice: currentShortPosition.currentPrice ? currentShortPosition.currentPrice.toFixed(currentShortPosition.pricePrecision) : 'N/A',
            unrealizedPnl: currentShortPosition.unrealizedPnl !== undefined ? currentShortPosition.unrealizedPnl.toFixed(2) : 'N/A',
            initialQuantity: currentShortPosition.initialQuantity ? currentShortPosition.initialQuantity.toFixed(currentShortPosition.quantityPrecision) : 'N/A',
            closedAmount: currentShortPosition.closedLossAmount.toFixed(currentShortPosition.quantityPrecision), // Hiện tổng số lượng đã đóng lỗ
            nextPartialCloseLossIndex: currentShortPosition.nextPartialCloseLossIndex,
            currentTPId: currentShortPosition.currentTPId || 'N/A',
            currentSLId: currentShortPosition.currentSLId || 'N/A',
        });
    }

    try {
        const openOrders = botRunning ? await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: TARGET_COIN_SYMBOL }) : [];
        const filteredOpenOrders = openOrders.filter(o => o.symbol === TARGET_COIN_SYMBOL && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

        res.json({
            running: botRunning,
            status: statusMessage,
            uptime: uptime,
            targetCoin: TARGET_COIN_SYMBOL,
            initialInvestment: INITIAL_INVESTMENT_AMOUNT,
            currentMarketPrice: currentMarketPrice ? currentMarketPrice.toFixed(exchangeInfoCache?.[TARGET_COIN_SYMBOL]?.pricePrecision || 2) : 'N/A',
            totalProfit: totalProfit.toFixed(2),
            totalLoss: totalLoss.toFixed(2),
            netPNL: netPNL.toFixed(2),
            positions: positionsDisplay,
            openOrders: filteredOpenOrders.map(o => ({
                orderId: o.orderId,
                side: o.side,
                positionSide: o.positionSide,
                type: o.type,
                quantity: parseFloat(o.origQty).toFixed(exchangeInfoCache?.[TARGET_COIN_SYMBOL]?.quantityPrecision || 4),
                stopPrice: o.stopPrice ? parseFloat(o.stopPrice).toFixed(exchangeInfoCache?.[TARGET_COIN_SYMBOL]?.pricePrecision || 2) : 'N/A',
                status: o.status,
                clientOrderId: o.clientOrderId
            })),
            isClosingPosition: isClosingPosition
        });
    } catch (error) {
        addLog(`Lỗi khi lấy trạng thái: ${error.message}`);
        res.status(500).json({ error: error.message, running: botRunning, status: statusMessage, uptime: uptime });
    }
});

// Endpoint để đọc log của bot
app.get('/logs', (req, res) => {
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi đọc file log:', err);
            return res.status(500).send('Không thể đọc file log.');
        }
        res.type('text/plain').send(data);
    });
});

// Endpoint để cấu hình và khởi động bot
app.post('/start', async (req, res) => {
    const { initialInvestmentAmount, targetCoinSymbol } = req.body;

    if (!initialInvestmentAmount || !targetCoinSymbol) {
        return res.status(400).json({ success: false, message: 'Thiếu tham số (initialInvestmentAmount, targetCoinSymbol).' });
    }

    INITIAL_INVESTMENT_AMOUNT = parseFloat(initialInvestmentAmount);
    TARGET_COIN_SYMBOL = targetCoinSymbol.toUpperCase();

    addLog(`Cấu hình mới: Vốn đầu tư: ${INITIAL_INVESTMENT_AMOUNT}, Cặp giao dịch: ${TARGET_COIN_SYMBOL}`);

    try {
        await startBotLogicInternal();
        res.json({ success: true, message: 'Bot đang khởi động...' });
    } catch (error) {
        res.status(500).json({ success: false, message: `Lỗi khi khởi động bot: ${error.message}` });
    }
});

// Endpoint để dừng bot
app.post('/stop', async (req, res) => {
    try {
        await stopBotLogicInternal();
        res.json({ success: true, message: 'Bot đang dừng...' });
    } catch (error) {
        res.status(500).json({ success: false, message: `Lỗi khi dừng bot: ${error.message}` });
    }
});

// Endpoint để đóng một vị thế cụ thể (LONG hoặc SHORT)
app.post('/close-position', async (req, res) => {
    const { positionSide } = req.body;
    if (!positionSide || (positionSide !== 'LONG' && positionSide !== 'SHORT')) {
        return res.status(400).json({ success: false, message: 'Vui lòng chỉ định positionSide hợp lệ: LONG hoặc SHORT.' });
    }

    let positionToClose = null;
    if (positionSide === 'LONG' && currentLongPosition) {
        positionToClose = currentLongPosition;
    } else if (positionSide === 'SHORT' && currentShortPosition) {
        positionToClose = currentShortPosition;
    }

    if (!positionToClose) {
        return res.status(404).json({ success: false, message: `Không tìm thấy vị thế ${positionSide} để đóng.` });
    }

    try {
        // Hủy tất cả các lệnh chờ liên quan đến vị thế này trước
        await cancelOpenOrdersForSymbol(TARGET_COIN_SYMBOL, null, positionSide);
        // Sau đó đóng vị thế
        await closePosition(TARGET_COIN_SYMBOL, Math.abs(positionToClose.quantity), `Đóng thủ công ${positionSide}`, positionSide);
        res.json({ success: true, message: `Đang gửi lệnh đóng vị thế ${positionSide} cho ${TARGET_COIN_SYMBOL}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: `Lỗi khi đóng vị thế ${positionSide}: ${error.message}` });
    }
});

// Endpoint để đóng tất cả các vị thế đang mở
app.post('/close-all-positions', async (req, res) => {
    try {
        const closePromises = [];
        if (currentLongPosition) {
            closePromises.push(cancelOpenOrdersForSymbol(TARGET_COIN_SYMBOL, null, 'LONG').then(() => 
                               closePosition(TARGET_COIN_SYMBOL, Math.abs(currentLongPosition.quantity), 'Đóng tất cả thủ công', 'LONG')));
        }
        if (currentShortPosition) {
            closePromises.push(cancelOpenOrdersForSymbol(TARGET_COIN_SYMBOL, null, 'SHORT').then(() =>
                               closePosition(TARGET_COIN_SYMBOL, Math.abs(currentShortPosition.quantity), 'Đóng tất cả thủ công', 'SHORT')));
        }
        
        if (closePromises.length === 0) {
            return res.status(404).json({ success: false, message: 'Không có vị thế nào đang mở để đóng.' });
        }

        await Promise.all(closePromises);
        res.json({ success: true, message: `Đang gửi lệnh đóng tất cả vị thế cho ${TARGET_COIN_SYMBOL}.` });
    } catch (error) {
        res.status(500).json({ success: false, message: `Lỗi khi đóng tất cả vị thế: ${error.message}` });
    }
});


// Khởi chạy Web Server
app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web Server UI đang chạy tại http://localhost:${WEB_SERVER_PORT}`);
});

