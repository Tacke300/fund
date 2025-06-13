
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
let currentLongPosition = null;
/* Cấu trúc object `position` sẽ chứa:
{
    symbol: string,
    quantity: number, // Số lượng hiện tại trên sàn
    initialQuantity: number, // Số lượng ban đầu khi mở lệnh
    entryPrice: number,
    initialTPPrice: number, // Giá TP ban đầu
    initialSLPrice: number, // Giá SL ban đầu (null nếu bị hủy)
    initialMargin: number,
    openTime: Date,
    pricePrecision: number,
    side: 'LONG'|'SHORT',
    currentPrice: number, // Giá thị trường hiện tại
    unrealizedPnl: number, // PNL chưa hiện thực hóa
    currentTPId: string, // ID của lệnh TP đang chờ
    currentSLId: string, // ID của lệnh SL đang chờ (null nếu bị hủy)

    // Các biến cho logic đóng một phần lệnh lãi (nếu có, nhưng yêu cầu hiện tại là không)
    closedAmount: number, // Tổng số vốn (ban đầu) đã đóng từng phần từ lệnh lãi

    // Các biến cho logic đóng một phần lệnh lỗ (dựa trên lãi của lệnh lãi)
    partialCloseLossLevels: number[], // Các mốc % lãi của lệnh lãi để đóng lệnh lỗ
    nextPartialCloseLossIndex: number, // Index của mốc đóng lệnh lỗ tiếp theo
    closedQuantity: number, // Tổng số lượng (quantity) của lệnh lỗ đã đóng một phần
    partialClosePrices: number[], // Lưu giá entry của lệnh lỗ tại thời điểm từng lần đóng một phần

    // Cờ để quản lý trạng thái điều chỉnh SL
    hasRemovedInitialSL: boolean, // MỚI: Cờ hiệu đã hủy SL ban đầu của lệnh lãi
    hasAdjustedSL6thClose: boolean, // Cờ hiệu đã điều chỉnh SL lần 6
    hasAdjustedSL8thClose: boolean, // Cờ hiệu đã điều chỉnh SL lần 8
    maxLeverageUsed: number, // Đòn bẩy đã sử dụng khi mở lệnh
}
*/
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
const ERROR_RETRY_DELAY_MS = 10000; // 10 giây

const logCounts = {}; // Đối tượng để theo dõi tần suất log
const LOG_COOLDOWN_MS = 2000; // Thời gian cooldown cho mỗi loại log (2 giây)

class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError'; // Đặt tên lỗi tùy chỉnh
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DUC (GIÁ TRỊ MẶC ĐỊNH) ---
let INITIAL_INVESTMENT_AMOUNT = 0.12; // Mặc định 0.12 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'HOMEUSDT'; // Mặc định HOMEUSDT (sẽ được cập nhật từ UI)

// Biến để lưu trữ tổng lời/lỗ
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

// --- BIẾN TRẠẠNG THÁI WEBSOCKET ---
let marketWs = null; // WebSocket cho dữ liệu thị trường (giá)
let userDataWs = null; // WebSocket cho dữ liệu người dùng (lệnh khớp, số dư)
let listenKey = null; // ListenKey cho User Data Stream
let listenKeyRefreshInterval = null; // setInterval để làm mới listenKey
let currentMarketPrice = null; // Cache giá từ WebSocket

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1111; // Cổng cho Web Server
// Lấy tên process từ PM2 environment variable, nếu không có thì dùng 'test'
const THIS_BOT_PM2_NAME = process.env.PM2_NAME || 'test';
const BOT_LOG_FILE = `/home/tacke300/.pm2/logs/${THIS_BOT_PM2_NAME}-out.log`;

// --- LOGGING TO FILE ---
const CUSTOM_LOG_FILE = path.join(__dirname, 'pm2.log'); // File log tùy chỉnh
const LOG_TO_CUSTOM_FILE = true; // Bật/tắt ghi log vào file tùy chỉnh

// --- HÀM TIỆN ÍCH ---

/**
 * Ghi log ra console và file tùy chỉnh. Hỗ trợ tần suất log.
 * @param {string} message - Nội dung log.
 */
function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    // Tạo hash cho message để theo dõi tần suất
    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        // Nếu đã quá thời gian cooldown, reset count và lastLoggedTime
        if ((now.getTime() - logCounts[messageHash].lastLoggedTime.getTime()) >= LOG_COOLDOWN_MS) {
            logCounts[messageHash] = { count: 0, lastLoggedTime: now };
        }

        logCounts[messageHash].count++;
        // Chỉ log nếu là lần đầu tiên sau reset hoặc sau cooldown
        if (logCounts[messageHash].count > 1) {
            console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
             if (LOG_TO_CUSTOM_FILE) {
                fs.appendFile(CUSTOM_LOG_FILE, `[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}\n`, (err) => {
                    if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
                });
            }
        } else { // count === 1, nghĩa là lần log đầu tiên hoặc sau khi reset cooldown
            console.log(logEntry);
            if (LOG_TO_CUSTOM_FILE) {
                fs.appendFile(CUSTOM_LOG_FILE, logEntry + '\n', (err) => {
                    if (err) console.error('Lỗi khi ghi log vào file tùy chỉnh:', err);
                });
            }
        }
        // Cập nhật lại thời gian ghi log cuối cùng cho tin nhắn này
        logCounts[messageHash].lastLoggedTime = now;
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

/**
 * Hàm chờ một khoảng thời gian.
 * @param {number} ms - Thời gian chờ (ms).
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Định dạng đối tượng Date sang chuỗi thời gian UTC+7.
 * @param {Date} dateObject - Đối tượng Date.
 * @returns {string} Chuỗi thời gian đã định dạng.
 */
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

/**
 * Tạo chữ ký HMAC SHA256 cho chuỗi truy vấn API.
 * @param {string} queryString - Chuỗi truy vấn.
 * @param {string} apiSecret - API Secret Key.
 * @returns {string} Chữ ký hex.
 */
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

/**
 * Thực hiện một HTTP Request.
 * @param {string} method - Phương thức HTTP (GET, POST, PUT, DELETE).
 * @param {string} hostname - Hostname (ví dụ: fapi.binance.com).
 * @param {string} path - Đường dẫn API (ví dụ: /fapi/v1/time).
 * @param {object} headers - Các HTTP headers.
 * @param {string} [postData=''] - Dữ liệu gửi đi cho POST/PUT request.
 * @returns {Promise<string>} Promise resolve với dữ liệu response hoặc reject với lỗi.
 */
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

        if (method === 'POST' || method === 'PUT') { // Chỉ gửi postData cho POST và PUT
            req.write(postData);
        }
        req.end();
    });
}

/**
 * Gọi API Binance có chữ ký (yêu cầu API Key và Secret Key).
 * @param {string} fullEndpointPath - Đường dẫn đầy đủ của endpoint (ví dụ: /fapi/v1/account).
 * @param {string} method - Phương thức HTTP (GET, POST, PUT, DELETE).
 * @param {object} [params={}] - Các tham số của request.
 * @returns {Promise<object>} Promise resolve với dữ liệu JSON hoặc reject với lỗi.
 */
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new CriticalApiError("❌ Missing Binance API_KEY hoặc API_SECRET. Vui lòng kiểm tra file config.js.");
    }
    const recvWindow = 5000; // Thời gian cửa sổ nhận (ms)
    const timestamp = Date.now() + serverTimeOffset; // Thời gian hiện tại sau khi đồng bộ với server Binance

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
        headers['Content-Type'] = 'application/json'; // Thêm Content-Type cho GET
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
        headers['Content-Type'] = 'application/json'; // Thêm Content-Type cho DELETE
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0; // Reset số lỗi liên tiếp nếu request thành công
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++; // Tăng số lỗi liên tiếp
        addLog(`Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        // Gợi ý khắc phục dựa trên mã lỗi phổ biến
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
        } else if (error.code === 451) { // Lỗi từ chối IP (Unavailable For Legal Reasons)
            addLog("  -> LỖI TỪ CHỐI IP: Dịch vụ không khả dụng từ vị trí này. Cần đổi VPS hoặc dùng Proxy.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error;
    }
}

/**
 * Gọi API Binance công khai (không yêu cầu chữ ký).
 * @param {string} fullEndpointPath - Đường dẫn đầy đủ của endpoint (ví dụ: /fapi/v1/time).
 * @param {object} [params={}] - Các tham số của request.
 * @returns {Promise<object>} Promise resolve với dữ liệu JSON hoặc reject với lỗi.
 */
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
        consecutiveApiErrors = 0; // Reset số lỗi liên tiếp nếu request thành công
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++; // Tăng số lỗi liên tiếp
        addLog(`Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        // Gợi ý khắc phục dựa trên mã lỗi phổ biến
        if (error.code === -1003) {
            addLog("  -> BỊ CẤM IP TẠM THỜI (RATE LIMIT). CẦN GIẢM TẦN SUẤT GỌI API!");
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        } else if (error.code === 451) { // Lỗi từ chối IP (Unavailable For Legal Reasons)
            addLog("  -> LỖI TỪ CHỐI IP: Dịch vụ không khả dụng từ vị trí này. Cần đổi VPS hoặc dùng Proxy.");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error;
    }
}

/**
 * Đồng bộ thời gian của bot với server Binance để tránh lỗi timestamp.
 */
async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
        addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`);
    } catch (error) {
        addLog(`Lỗi đồng bộ thời gian: ${error.message}.`);
        serverTimeOffset = 0; // Đặt về 0 để tránh lỗi timestamp nếu không đồng bộ được
        throw error; // Ném lỗi để bot biết và dừng/khởi động lại
    }
}

/**
 * Lấy đòn bẩy tối đa cho một cặp giao dịch.
 * @param {string} symbol - Cặp giao dịch (ví dụ: BTCUSDT).
 * @returns {Promise<number|null>} Đòn bẩy tối đa hoặc null nếu lỗi.
 */
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });
        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);
            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                // Lấy initialLeverage từ bracket đầu tiên hoặc maxInitialLeverage nếu có
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

/**
 * Đặt đòn bẩy cho một cặp giao dịch.
 * @param {string} symbol - Cặp giao dịch.
 * @param {number} leverage - Mức đòn bẩy.
 * @returns {Promise<boolean>} True nếu thành công, False nếu lỗi.
 */
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
        // Xử lý các lỗi cụ thể liên quan đến đòn bẩy
        if (error.code === -4046 || error.code === -4048) {
             addLog(`Đòn bẩy ${leverage}x không hợp lệ cho ${symbol}.`);
             return false;
        }
        return false;
    }
}

/**
 * Lấy và cache thông tin sàn giao dịch (minQty, stepSize, pricePrecision, etc.).
 * @returns {Promise<object>} Đối tượng chứa thông tin sàn cho các symbol.
 */
async function getExchangeInfo() {
    if (exchangeInfoCache) { // Trả về từ cache nếu đã có
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
        exchangeInfoCache = null; // Reset cache nếu lỗi
        throw error;
    }
}

/**
 * Lấy chi tiết filters (minQty, stepSize, pricePrecision, etc.) cho một symbol.
 * @param {string} symbol - Cặp giao dịch.
 * @returns {Promise<object|null>} Đối tượng chi tiết symbol hoặc null nếu không tìm thấy.
 */
async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        addLog(`Không tìm thấy filters cho ${symbol}.`);
        return null;
    }
    return filters[symbol];
}

/**
 * Lấy giá thị trường hiện tại của một cặp giao dịch.
 * @param {string} symbol - Cặp giao dịch.
 * @returns {Promise<number|null>} Giá hiện tại hoặc null nếu lỗi.
 */
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        const price = parseFloat(data.price);
        return price;
    } catch (error) {
        addLog(`Lỗi lấy giá hiện tại cho ${symbol} từ REST API: ${error.msg || error.message}`);
        // Không dừng bot nếu chỉ lỗi lấy giá, nhưng ném lỗi CriticalApiError nếu lỗi liên tiếp.
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
 * @param {string} [positionSide] - 'LONG' hoặc 'SHORT' hoặc 'BOTH' để hủy lệnh theo positionSide.
 */
async function cancelOpenOrdersForSymbol(symbol, orderId = null, positionSide = null) {
    try {
        let params = { symbol: symbol };
        // Nếu có orderId, chỉ hủy lệnh đó
        if (orderId) {
            params.orderId = orderId;
        }

        // Nếu positionSide được chỉ định (trừ 'BOTH'), thêm vào params
        if (positionSide && positionSide !== 'BOTH') {
             params.positionSide = positionSide;
        }

        if (orderId) {
            addLog(`Đang hủy lệnh ${orderId} cho ${symbol} (positionSide: ${positionSide || 'Tất cả'}).`);
            await callSignedAPI('/fapi/v1/order', 'DELETE', params);
            addLog(`Đã hủy lệnh ${orderId} cho ${symbol}.`);
        } else {
            addLog(`Đang hủy tất cả lệnh chờ cho ${symbol} (positionSide: ${positionSide || 'Tất cả'}).`);
            // Gọi endpoint allOpenOrders để hủy tất cả lệnh
            await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', params);
            addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
        }
    } catch (error) {
        // Lỗi -2011 (Unknown order) thường xảy ra khi lệnh đã khớp/hủy rồi, có thể bỏ qua
        if (error.code === -2011) {
            addLog(`Không có lệnh chờ nào để hủy cho ${symbol} (OrderId: ${orderId || 'TẤT CẢ'}, positionSide: ${positionSide || 'TẤT CẢ'}).`);
        } else {
            addLog(`Lỗi hủy lệnh chờ cho ${symbol} (OrderId: ${orderId || 'TẤT CẢ'}, positionSide: ${positionSide || 'TẤT CẢ'}): ${error.msg || error.message}`);
        }
        if (error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi hủy lệnh.`);
             stopBotLogicInternal();
        }
    }
}

/**
 * Hàm xử lý kết quả giao dịch từ User Data Stream và điều chỉnh tổng PNL.
 * Quan trọng: Hàm này cũng quyết định khi nào thì đóng vị thế đối ứng và reset chu kỳ.
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

    // Kiểm tra xem lệnh khớp có phải là TP/SL chính thức của bot không
    let isBotTPorSL = false;
    if (currentLongPosition && (orderId === currentLongPosition.currentTPId || orderId === currentLongPosition.currentSLId)) {
        isBotTPorSL = true;
    } else if (currentShortPosition && (orderId === currentShortPosition.currentTPId || orderId === currentShortPosition.currentSLId)) {
        isBotTPorSL = true;
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
        `🔴 [TRADE CLOSED] ${positionSide} ${symbol}`,
        `├─ PNL: ${parseFloat(realizedPnl).toFixed(2)} USDT`,
        `├─ Tổng Lời: ${totalProfit.toFixed(2)} USDT`,
        `├─ Tổng Lỗ: ${totalLoss.toFixed(2)} USDT`,
        `└─ PNL Ròng: ${netPNL.toFixed(2)} USDT`
    ].join('\n'));

    // Nếu đây là lệnh TP/SL chính thức của bot, xử lý đóng toàn bộ chu kỳ và reset
    if (isBotTPorSL) {
        addLog(`Lệnh TP/SL chính cho ${symbol} (${positionSide}) đã khớp. Đang đóng vị thế còn lại và reset chu kỳ.`);

        let otherPosition = null;   // Vị thế đối ứng

        if (positionSide === 'LONG') { // Nếu lệnh LONG vừa khớp TP/SL
            otherPosition = currentShortPosition;
            currentLongPosition = null; // Đặt về null ngay sau khi lệnh chính khớp
        } else if (positionSide === 'SHORT') { // Nếu lệnh SHORT vừa khớp TP/SL
            otherPosition = currentLongPosition;
            currentShortPosition = null; // Đặt về null ngay sau khi lệnh chính khớp
        }

        // Đóng vị thế đối ứng nếu nó còn tồn tại và có số lượng
        if (otherPosition && Math.abs(otherPosition.quantity) > 0) {
            addLog(`Đang đóng lệnh ${otherPosition.side} (${symbol}) còn lại.`);
            await closePosition(otherPosition.symbol, Math.abs(otherPosition.quantity), `Đóng do lệnh ${positionSide} khớp TP/SL`, otherPosition.side);
        } else {
             addLog(`Không tìm thấy lệnh đối ứng còn lại để đóng hoặc đã đóng rồi.`);
             // Nếu lệnh đối ứng đã không còn, vẫn dọn dẹp và reset chu kỳ
             await cleanupAndResetCycle(symbol);
        }

        // Nếu lệnh đối ứng CÓ, cleanupAndResetCycle sẽ được gọi SAU KHI lệnh đóng nốt đó khớp
        // qua processTradeResult.
        // Nếu lệnh đối ứng KHÔNG CÓ (else block trên), cleanupAndResetCycle được gọi ngay.

    } else {
        // Nếu không phải lệnh TP/SL chính (ví dụ: lệnh đóng một phần hoặc một lệnh thị trường khác)
        addLog(`Lệnh khớp ${orderId} (PNL: ${parseFloat(realizedPnl).toFixed(2)}) không phải lệnh TP/SL chính của bot. Giả định là lệnh đóng từng phần hoặc lệnh thị trường khác. Không reset chu kỳ bot.`);
        // Logic `manageOpenPosition` sẽ chịu trách nhiệm cập nhật trạng thái vị thế tổng thể
        // và xử lý các điều kiện phức tạp hơn.
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
    if (symbol !== TARGET_COIN_SYMBOL) { // Đảm bảo chỉ đóng lệnh cho đồng coin đang theo dõi
        addLog(`Bỏ qua đóng vị thế cho ${symbol}. Chỉ đóng cho ${TARGET_COIN_SYMBOL}.`);
        return;
    }

    if (!positionSide || (positionSide !== 'LONG' && positionSide !== 'SHORT')) { // Bắt buộc phải có positionSide trong Hedge Mode
        addLog(`Lỗi: closePosition yêu cầu positionSide (LONG/SHORT) rõ ràng trong Hedge Mode. Lý do: ${reason}.`);
        return;
    }

    if (isClosingPosition) { // Tránh gửi nhiều lệnh đóng cùng lúc
        addLog(`Đang trong quá trình đóng vị thế ${symbol}. Bỏ qua yêu cầu đóng mới.`);
        return;
    }
    isClosingPosition = true; // Đặt cờ đang đóng

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
        // Tìm vị thế thực tế trên sàn
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && p.positionSide === positionSide && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} (PositionSide: ${positionSide}) đã đóng trên sàn hoặc không có vị thế để đóng. Lý do: ${reason}.`);
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));
            // Side của lệnh đóng sẽ ngược với positionSide của vị thế
            const closeSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';

            if (adjustedActualQuantity <= 0) {
                addLog(`Số lượng đóng (${adjustedActualQuantity}) cho ${symbol} (PositionSide: ${positionSide}) không hợp lệ. Không gửi lệnh đóng.`);
                isClosingPosition = false;
                return;
            }

            // Hủy lệnh TP/SL chờ của vị thế này trước khi đóng hoàn toàn
            addLog(`Hủy lệnh TP/SL chờ cho vị thế ${positionSide} ${symbol} trước khi đóng hoàn toàn.`);
            await cancelOpenOrdersForSymbol(symbol, null, positionSide);
            await sleep(500); // Đợi lệnh hủy hoàn tất

            addLog(`Gửi lệnh đóng: ${symbol}, Side: ${closeSide}, PositionSide: ${positionSide}, Type: 'MARKET', Qty: ${adjustedActualQuantity}`);

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                positionSide: positionSide, // Quan trọng: Đặt positionSide cho lệnh
                type: 'MARKET',
                quantity: adjustedActualQuantity,
            });

            addLog(`Đã gửi lệnh đóng ${closeSide} ${symbol} (PositionSide: ${positionSide}). Lý do: ${reason}.`);
            // Lưu ý: Không reset local position object ở đây. processTradeResult sẽ làm việc đó khi lệnh khớp hoàn toàn báo về qua WebSocket.
            await sleep(1000); // Đợi lệnh khớp
        }

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol} (PositionSide: ${positionSide}): ${error.msg || error.message}`);
        // Xử lý lỗi -2011 nếu lệnh đã không tồn tại
        if (error.code === -2011) {
            addLog(`Lỗi -2011 khi đóng vị thế ${symbol} (PositionSide: ${positionSide}), có thể vị thế đã đóng. Kiểm tra lại.`);
            // await checkAndHandleRemainingPosition(symbol); // Tránh gọi lặp lại quá nhiều nếu bot đang lỗi API nghiêm trọng
            // Logic syn củamanageOpenPosition/processTradeResult sẽ tự động xử lý việc vị thế bị đóng trên sàn.
        }
        else if (error instanceof CriticalApiError) { // Dừng bot nếu lỗi API nghiêm trọng
            addLog(`Bot dừng do lỗi API nghiêm trọng khi cố gắng đóng vị thế.`);
            stopBotLogicInternal();
        }
    } finally {
        isClosingPosition = false; // Reset cờ đang đóng
    }
}

/**
 * Hàm mở lệnh (Long hoặc Short) và đặt TP/SL ban đầu.
 * Hàm này sẽ được gọi khi bot quyết định mở một cặp lệnh mới.
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

        // Đặt đòn bẩy cho symbol này
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`);
            return null;
        }
        await sleep(500); // Đợi một chút để cài đặt đòn bẩy có hiệu lực

        const { pricePrecision, quantityPrecision, minNotional, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            return null;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = INITIAL_INVESTMENT_AMOUNT;

        // Kiểm tra số dư khả dụng
        // Note: check số dư 1 lần ở runTradingLogic, không cần check chi tiết ở đây nữa
        // if (usdtBalance < capitalToUse) {
        //     addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}).`);
        //     return null;
        // }

        // Tính toán số lượng dựa trên vốn, đòn bẩy và giá hiện tại
        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize; // Làm tròn theo stepSize
        quantity = parseFloat(quantity.toFixed(quantityPrecision)); // Làm tròn theo quantityPrecision

        // Kiểm tra minNotional
        if (quantity <= 0 || quantity * currentPrice < minNotional) {
            addLog(`Số lượng hoặc giá trị lệnh quá nhỏ (${quantity.toFixed(quantityPrecision)} Qty, Notional: ${quantity * currentPrice.toFixed(8)}). Hủy.`);
            return null;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        // Gửi lệnh MARKET để mở vị thế
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            positionSide: tradeDirection, // Quan trọng: Đặt positionSide
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' // Yêu cầu response đầy đủ
        });

        addLog(`Đã gửi lệnh MARKET để mở ${tradeDirection} ${symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000); // Đợi lệnh khớp một chút

        // Lấy thông tin vị thế thực tế sau khi lệnh khớp
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
        await cancelOpenOrdersForSymbol(symbol, null, tradeDirection);
        addLog(`Đã hủy các lệnh chờ cũ (nếu có) cho ${symbol} (PositionSide: ${tradeDirection}).`);
        await sleep(500); // Đợi lệnh hủy hoàn tất

        // --- BẮT ĐẦU TÍNH TOÁN TP/SL THEO % VỐN (dùng giá vào lệnh thực tế và số lượng thực tế) ---
        let TAKE_PROFIT_MULTIPLIER; // Ví dụ: 10 cho 1000%
        let STOP_LOSS_MULTIPLIER; // Ví dụ: 6.66 cho 666%
        // Các mốc % lãi của lệnh lãi để đóng lệnh lỗ
        let partialCloseLossSteps = [];

        // Cấu hình TP/SL và các mốc đóng từng phần theo đòn bẩy
        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; // 1000%
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; // 500% (YÊU CẦU: SL = 1/2 TP)
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100); // 100%, 200%, ..., 800%
        } else if (maxLeverage === 50) {
            TAKE_PROFIT_MULTIPLIER = 5;  // 500%
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; // 250% (YÊU CẦU: SL = 1/2 TP)
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50); // 50%, 100%, ..., 400%
        } else if (maxLeverage <= 25) { // Đòn bẩy <= 25 (bao gồm 25x, 20x, v.v.)
            TAKE_PROFIT_MULTIPLIER = 3.5; // Mặc định 350%
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; // 175% (YÊU CẦU: SL = 1/2 TP)
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); // 150%, 300%, ..., 1200%
        } else { // Trường hợp đòn bẩy khác các mốc trên (ví dụ: 30x, 40x...)
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc TP/SL/Partial Close. Sử dụng mặc định (TP 350%, SL 175%, Partial 150%).`);
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 1.75;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 350);
        }

        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_MULTIPLIER;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_MULTIPLIER;

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        const orderSideToClose = (tradeDirection === 'LONG') ? 'SELL' : 'BUY'; // Side của lệnh để đóng vị thế

        if (tradeDirection === 'LONG') {
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            // Làm tròn xuống cho SL và TP của LONG
            slPrice = Math.floor(slPrice / tickSize) * tickSize;
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize;

        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            // Làm tròn lên cho SL và TP của SHORT
            slPrice = Math.ceil(slPrice / tickSize) * tickSize;
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize;
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`Giá Entry ${tradeDirection}: ${entryPrice.toFixed(pricePrecision)}`);
        addLog(`TP ${tradeDirection}: ${tpPrice.toFixed(pricePrecision)} (target ${TAKE_PROFIT_MULTIPLIER * 100}% vốn), SL ${tradeDirection}: ${slPrice.toFixed(pricePrecision)} (limit ${STOP_LOSS_MULTIPLIER * 100}% vốn)`);

        let placedSLOrderId = null;
        try {
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: orderSideToClose, // Side của lệnh
                positionSide: tradeDirection, // PositionSide của vị thế
                type: 'STOP_MARKET',
                quantity: actualQuantity,
                stopPrice: slPrice,
                closePosition: 'true', // Luôn dùng closePosition=true với STOP_MARKET/TAKE_PROFIT_MARKET
                newOrderRespType: 'FULL'
            });
            placedSLOrderId = slOrderResult.orderId;
            addLog(`Đã đặt SL cho ${tradeDirection} ${symbol} @ ${slPrice.toFixed(pricePrecision)}. OrderId: ${placedSLOrderId}`);
            await sleep(500);
        } catch (slError) {
            addLog(`Lỗi đặt SL cho ${tradeDirection} ${symbol}: ${slError.msg || slError.message}.`);
            // Nếu SL kích hoạt ngay lập tức, đóng vị thế
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${tradeDirection} ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, `SL ${tradeDirection} kích hoạt ngay`, tradeDirection);
                return null;
            }
        }

        let placedTPOrderId = null;
        try {
            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: orderSideToClose, // Side của lệnh
                positionSide: tradeDirection, // PositionSide của vị thế
                type: 'TAKE_PROFIT_MARKET',
                quantity: actualQuantity,
                stopPrice: tpPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            placedTPOrderId = tpOrderResult.orderId;
            addLog(`Đã đặt TP cho ${tradeDirection} ${symbol} @ ${tpPrice.toFixed(pricePrecision)}. OrderId: ${placedTPOrderId}`);
            await sleep(500);
        } catch (tpError) {
            addLog(`Lỗi đặt TP cho ${tradeDirection} ${symbol}: ${tpError.msg || tpError.message}.`);
            // Nếu TP kích hoạt ngay lập tức, đóng vị thế
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${tradeDirection} ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, `TP ${tradeDirection} kích hoạt ngay`, tradeDirection);
                return null;
            }
        }

        // Tạo đối tượng vị thế để lưu trữ trạng thái trong bot
        const positionData = {
            symbol: symbol,
            quantity: actualQuantity, // Số lượng hiện tại
            initialQuantity: actualQuantity, // Số lượng ban đầu khi mở lệnh
            entryPrice: entryPrice,
            initialTPPrice: tpPrice, // Giá TP ban đầu
            initialSLPrice: placedSLOrderId ? slPrice : null, // Giá SL ban đầu (có thể là null nếu đặt lỗi)
            initialMargin: capitalToUse,
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection, // Side của vị thế (LONG/SHORT)
            currentPrice: currentPrice, // Giá hiện tại (sẽ cập nhật liên tục từ WebSocket)
            unrealizedPnl: 0, // PNL chưa hiện thực hóa (sẽ cập nhật liên tục)
            currentTPId: placedTPOrderId, // ID của lệnh TP đang chờ
            currentSLId: placedSLOrderId, // ID của lệnh SL đang chờ

            // Thuộc tính cho logic đóng một phần/điều chỉnh SL
            closedAmount: 0, // Tổng số vốn (ban đầu) đã đóng từng phần từ lệnh lãi (không dùng cho yêu cầu này)
            partialCloseLossLevels: partialCloseLossSteps, // Các mốc % lãi của lệnh lãi để đóng lệnh lỗ
            nextPartialCloseLossIndex: 0, // Index của mốc đóng lỗ tiếp theo (cho lệnh lỗ)
            closedQuantity: 0, // Tổng số lượng (quantity) của lệnh lỗ đã đóng một phần
            partialClosePrices: [], // Lưu giá entry của lệnh lỗ tại thời điểm từng lần đóng một phần (dùng cho logic mở lại)

            // Cờ để quản lý trạng thái điều chỉnh SL
            // Ban đầu SL của lệnh lãi có đòn bẩy >=75x sẽ bị hủy, set cờ tương ứng
            hasRemovedInitialSL: (tradeDirection === 'LONG' && maxLeverage >= 75),
            hasAdjustedSL6thClose: false, // Cờ hiệu đã điều chỉnh SL lần 6
            hasAdjustedSL8thClose: false, // Cờ hiệu đã điều chỉnh SL lần 8
            maxLeverageUsed: maxLeverage, // Lưu đòn bẩy đã sử dụng
        };

        return positionData;

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`);
            stopBotLogicInternal();
        } else {
            // Đối với các lỗi không nghiêm trọng khi mở lệnh, đợi 5s và trả về null
            addLog(`Đợi 5 giây trước khi lên lịch chu kỳ mới sau lỗi mở lệnh.`);
             await sleep(5000);
             // runTradingLogic sẽ xử lý việc trả về null này
            return null;
        }
    }
}

/**
 * Hàm đóng một phần vị thế.
 * @param {object} position - Vị thế cần đóng từng phần (sẽ là lệnh lỗ).
 * @param {number} percentageOfInitialQuantity - Tỷ lệ phần trăm khối lượng ban đầu để đóng (ví dụ: 10).
 * @param {string} type - 'PROFIT' (cho lệnh lãi) hoặc 'LOSS' (cho lệnh lỗ). Dùng để ghi log và cập nhật `closedAmount`/`closedQuantity`/`partialClosePrices`.
 */
async function closePartialPosition(position, percentageOfInitialQuantity, type = 'PROFIT') {
    if (!position || position.initialQuantity === undefined || position.initialQuantity <= 0) {
        addLog(`Lỗi: Không có đối tượng position hợp lệ hoặc khối lượng ban đầu không hợp lệ (initialQuantity) cho lệnh ${position?.side} ${position?.symbol}. Không thể đóng từng phần.`);
        return;
    }

    addLog(`Đang đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh ${position.side} ${position.symbol} (type: ${type === 'PROFIT' ? 'từ lệnh lãi' : 'từ lệnh lỗ'}).`);

    try {
        const symbolInfo = await getSymbolDetails(position.symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${position.symbol}. Không đóng từng phần.`);
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;

        // Tính toán số lượng cần đóng dựa trên initialQuantity
        let quantityToClose = position.initialQuantity * (percentageOfInitialQuantity / 100);

        // Lấy thông tin vị thế thực tế trên sàn để đảm bảo số lượng hiện tại
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || Math.abs(parseFloat(currentPositionOnBinance.positionAmt)) === 0) {
            addLog(`Vị thế ${position.side} ${position.symbol} đã đóng trên sàn hoặc không tồn tại. Không thể đóng từng phần.`);
             // Cập nhật trạng thái local nếu cần (ví dụ nếu đây là hàm gọi thủ công, không qua stream)
            if (position.side === 'LONG') currentLongPosition = null;
            if (position.side === 'SHORT') currentShortPosition = null;
            return;
        }
        const actualPositionQuantity = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));

        // Hàm làm tròn số lượng theo stepSize của sàn
        const roundToStepSize = (qty, step) => {
            return Math.floor(qty / step) * step;
        };

        quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
        quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));

        // Ngưỡng giá trị tối thiểu cho lệnh đóng từng phần (tránh lỗi Binance "notional too low")
        const MIN_PARTIAL_CLOSE_VALUE_USDT = 0.003;

        if (quantityToClose <= 0) {
            addLog(`Số lượng đóng từng phần (${quantityToClose.toFixed(quantityPrecision)}) quá nhỏ hoặc bằng 0 cho ${position.symbol}.`);
            return;
        }

        // Lấy giá hiện tại để tính notional
        const currentPrice = position.currentPrice;
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
            quantityToClose = roundToStepSize(quantityToClose, symbolInfo.stepSize);
            quantityToClose = parseFloat(quantityToClose.toFixed(quantityPrecision));
        }

        if (quantityToClose <= 0) {
            addLog(`Sau khi kiểm tra, số lượng đóng từng phần vẫn là 0 hoặc không hợp lệ. Hủy đóng.`);
            return;
        }

        // Side của lệnh đóng sẽ ngược với positionSide của vị thế
        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';

        addLog(`Gửi lệnh đóng từng phần: ${position.symbol}, Side: ${closeSide}, PositionSide: ${position.side}, Type: 'MARKET', Qty: ${quantityToClose}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: closeSide,
            positionSide: position.side, // Quan trọng: Đặt positionSide cho lệnh
            type: 'MARKET',
            quantity: quantityToClose,
        });

        addLog(`Đã gửi lệnh đóng từng phần ${closeSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);

        // Việc cập nhật totalProfit/totalLoss sẽ được xử lý bởi hàm processTradeResult
        // khi User Data Stream báo về lệnh khớp hoàn toàn.

        if (type === 'PROFIT') { // Nếu là lệnh lãi được đóng một phần (theo yêu cầu thì không có logic này)
            // position.closedAmount += usdtAmountClosed; // Logic này không dùng cho yêu cầu hiện tại
        } else { // type === 'LOSS' (Lệnh lỗ được đóng một phần)
            // Cập nhật trạng thái local object (Lưu ý: processTradeResult mới cập nhật PNL)
            position.closedQuantity += quantityToClose; // Tổng số lượng lệnh lỗ đã đóng một phần
            // Lưu giá entry của lệnh lỗ tại thời điểm đóng một phần, CẦN LẤY GIÁ ENTRY MỚI NHẤT
            const positionsOnBinanceAfterClose = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const losingPosAfterClose = positionsOnBinanceAfterClose.find(p => p.symbol === position.symbol && p.positionSide === position.side);
             if (losingPosAfterClose) {
                const currentLosingEntryPrice = parseFloat(losingPosAfterClose.entryPrice);
                position.partialClosePrices.push(currentLosingEntryPrice); // Lưu giá entry hiện tại
                addLog(`Đã lưu giá entry mới nhất của lệnh lỗ (${currentLosingEntryPrice.toFixed(symbolInfo.pricePrecision)}) sau khi đóng từng phần.`);
            } else {
                 addLog(`Không tìm thấy lệnh lỗ ${position.side} ${position.symbol} sau khi đóng từng phần để lấy giá entry mới nhất. Lưu giá entry cũ.`);
                 position.partialClosePrices.push(position.entryPrice); // Lưu giá entry cũ nếu không lấy được mới
            }
        }

        addLog(`Đã gửi lệnh đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh ${position.side}.`);
        addLog(`Tổng lượng lệnh lỗ đã đóng một phần (bot state): ${position.closedQuantity.toFixed(quantityPrecision)}`);

        //await sleep(1000); // Đợi lệnh khớp - processTradeResult sẽ xử lý

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

/**
 * Hàm mở thêm vị thế để cân bằng lại số lượng đã đóng từng phần.
 * @param {object} position - Vị thế cần mở thêm (sẽ là lệnh lỗ).
 * @param {number} quantityToReopen - Số lượng (quantity) cần mở thêm để cân bằng.
 * @param {string} reason - Lý do mở thêm (ví dụ: 'Cân bằng lại lệnh lỗ').
 */
async function addPosition(position, quantityToReopen, reason) {
    if (!position) {
         addLog(`Lỗi: Đối tượng position không hợp lệ khi cố gắng mở thêm lệnh.`);
         return;
    }
     // Lấy số lượng hiện tại trên sàn trước khi quyết định addPosition
     const positionsOnBinanceCurrent = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
     const currentPositionOnBinance = positionsOnBinanceCurrent.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

    if (!currentPositionOnBinance) {
         addLog(`Lệnh lỗ ${position.side} đã đóng hoàn toàn trên sàn. Không cần mở thêm.`);
         if (position.side === 'LONG') currentLongPosition = null;
         if (position.side === 'SHORT') currentShortPosition = null;
         return; // Không cần mở thêm nếu vị thế đã đóng hoàn toàn
    }


    if (quantityToReopen <= 0) {
        addLog(`Không có số lượng để mở thêm cho lệnh ${position.side} ${position.symbol}.`);
        return;
    }

    addLog(`Đang mở thêm ${quantityToReopen.toFixed(position.quantityPrecision)} khối lượng cho lệnh ${position.side} ${position.symbol} (Lý do: ${reason}).`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể mở thêm lệnh.`);
            return;
        }

        const { quantityPrecision, minNotional, stepSize } = symbolDetails;
        const currentPrice = await getCurrentPrice(position.symbol);
        if (!currentPrice) {
            addLog(`Không có giá hiện tại hợp lệ cho ${position.symbol}. Không thể mở thêm.`);
            return;
        }

        const maxLeverage = position.maxLeverageUsed; // Sử dụng đòn bẩy đã lưu của vị thế
        if (!maxLeverage) {
            addLog(`Không thể lấy đòn bẩy đã sử dụng cho ${position.symbol}.`);
            return;
        }

        // Đảm bảo số lượng cần mở thêm đủ minNotional
        if (quantityToReopen * currentPrice < minNotional) {
            addLog(`Giá trị lệnh mở thêm (${(quantityToReopen * currentPrice).toFixed(8)} USDT) quá nhỏ. Hủy.`);
            return;
        }
         // Hàm làm tròn số lượng theo stepSize của sàn
        const roundToStepSize = (qty, step) => {
            return Math.floor(qty / step) * step;
        };
         let adjustedQuantityToReopen = roundToStepSize(quantityToReopen, symbolDetails.stepSize);
         adjustedQuantityToReopen = parseFloat(adjustedQuantityToReopen.toFixed(quantityPrecision));

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';

        addLog(`Gửi lệnh MARKET để mở thêm: ${position.symbol}, Side: ${orderSide}, PositionSide: ${position.side}, Type: 'MARKET', Qty: ${adjustedQuantityToReopen}`);

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side,
            type: 'MARKET',
            quantity: adjustedQuantityToReopen,
            newOrderRespType: 'FULL'
        });

        addLog(`Đã gửi lệnh MARKET để mở thêm ${orderSide} ${position.symbol}. OrderId: ${orderResult.orderId}`);
        await sleep(1000); // Đợi lệnh khớp

        // Lấy lại vị thế trên sàn để cập nhật entryPrice và quantity
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const updatedPositionOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (updatedPositionOnBinance) {
            position.entryPrice = parseFloat(updatedPositionOnBinance.entryPrice); // Giá vào trung bình mới
            position.quantity = Math.abs(parseFloat(updatedPositionOnBinance.positionAmt)); // Khối lượng mới

            addLog(`Đã mở thêm thành công cho ${position.side} ${position.symbol}. Số lượng mới: ${position.quantity.toFixed(quantityPrecision)}, Giá vào trung bình mới: ${position.entryPrice.toFixed(symbolDetails.pricePrecision)}.`);

            // RESET TRẠNG THÁI LIÊN QUAN ĐẾN ĐÓNG MỘT PHẦN VÀ ĐIỀU CHỈNH SL
            position.closedQuantity = 0; // Reset số lượng đã đóng một phần
            position.partialClosePrices = []; // Reset danh sách giá đóng một phần
            position.nextPartialCloseLossIndex = 0; // Reset index đóng phần lỗ tiếp theo


            // Các cờ điều chỉnh SL được đặt ở `winningPos`, nên cần reset chúng thông qua winningPos.
            // Vì hàm addPosition được gọi trên `losingPos`, ta cần tìm `winningPos` để reset cờ của nó.
            let winningPosToResetFlags = null;
            if (currentLongPosition && currentLongPosition.side !== position.side) winningPosToResetFlags = currentLongPosition;
            if (currentShortPosition && currentShortPosition.side !== position.side) winningPosToResetFlags = currentShortPosition;


            if (winningPosToResetFlags) {
                 winningPosToResetFlags.nextPartialCloseLossIndex = 0; // Lệnh lãi cũng cần reset index đóng lỗ
                winningPosToResetFlags.hasAdjustedSL6thClose = false;
                winningPosToResetFlags.hasAdjustedSL8thClose = false;
                // hasRemovedInitialSL có thể được giữ nguyên là false sau khi đặt lại SL
                 if (!winningPosToResetFlags.currentSLId) winningPosToResetFlags.hasRemovedInitialSL = true;
                 else winningPosToResetFlags.hasRemovedInitialSL = false; // Nếu đặt lại SL thành công
                addLog(`Đã reset các trạng thái đóng một phần/điều chỉnh SL cho lệnh lãi ${winningPosToResetFlags.side}.`);
            } else {
                 addLog(`Không tìm thấy lệnh lãi để reset trạng thái đóng một phần/điều chỉnh SL.`);
            }

            // Cập nhật lại TP và SL cho vị thế tổng cộng (cả 2 lệnh)
            addLog(`Đã cân bằng lại lệnh lỗ. Đang đặt lại TP/SL cho cả hai vị thế.`);
             // Gọi updateTPandSLForTotalPosition cho cả LONG và SHORT nếu chúng tồn tại
            if (currentLongPosition) await updateTPandSLForTotalPosition(currentLongPosition, currentLongPosition.maxLeverageUsed);
            if (currentShortPosition) await updateTPandSLForTotalPosition(currentShortPosition, currentShortPosition.maxLeverageUsed);


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
 * Hàm cập nhật lại lệnh TP và SL cho tổng vị thế sau khi mở thêm hoặc điều chỉnh.
 * Sẽ hủy TP/SL cũ và đặt mới dựa trên giá vào trung bình và số lượng hiện tại.
 * @param {object} position - Vị thế cần cập nhật TP/SL.
 * @param {number} maxLeverage - Đòn bẩy tối đa của symbol.
 */
async function updateTPandSLForTotalPosition(position, maxLeverage) {
    if (!position || !position.symbol) return;
    addLog(`Đang cập nhật TP/SL cho tổng vị thế ${position.side} ${position.symbol}.`);

    try {
        const symbolDetails = await getSymbolDetails(position.symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể cập nhật TP/SL.`);
            return;
        }
        const { pricePrecision, tickSize } = symbolDetails;

        // --- Xác định multipliers TP/SL dựa trên đòn bẩy
        let TAKE_PROFIT_MULTIPLIER;
        let STOP_LOSS_MULTIPLIER;
        // Sử dụng INITIAL_INVESTMENT_AMOUNT cố định để tính mục tiêu PNL cho TP/SL chính
        const CAPITAL_BASE_FOR_TP_SL = INITIAL_INVESTMENT_AMOUNT;


        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; // 1000% trên vốn BAN ĐẦU
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; // 500% trên vốn BAN ĐẦU
        } else if (maxLeverage === 50) {
            TAKE_PROFIT_MULTIPLIER = 5;  // 500% trên vốn BAN ĐẦU
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; // 250% trên vốn BAN ĐẦU
        } else if (maxLeverage <= 25) {
            TAKE_PROFIT_MULTIPLIER = 3.5; // 350% trên vốn BAN ĐẦU
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; // 175% trên vốn BAN ĐẦU
        } else {
             // Trường hợp đòn bẩy khác các mốc trên (ví dụ: 30x, 40x...)
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc TP/SL. Sử dụng mặc định (TP 350%, SL 175%).`);
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 1.75;
        }

        // Lấy số lượng thực tế của vị thế trên sàn
         const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
         const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) {
             addLog(`Vị thế ${position.side} không còn tồn tại trên Binance để cập nhật TP/SL. Bỏ qua.`);
             // Reset local state nếu nó chưa null
            if (position.side === 'LONG') currentLongPosition = null;
            if (position.side === 'SHORT') currentShortPosition = null;
            return;
        }

        const actualQuantity = Math.abs(parseFloat(currentPosOnBinance.positionAmt));
        const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);

        const profitTargetUSDT = CAPITAL_BASE_FOR_TP_SL * TAKE_PROFIT_MULTIPLIER;
        const lossLimitUSDT = CAPITAL_BASE_FOR_TP_SL * STOP_LOSS_MULTIPLIER;

        // Tính toán lại giá TP/SL dựa trên entryPrice THỰC TẾ TRÊN SÀN và actualQuantity THỰC TẾ
        // Đây là logic TP/SL cho TỔNG vị thế.
        // Lưu ý: Dùng actualQuantity, không phải initialQuantity hay position.quantity (local state)
        if (actualQuantity === 0) {
             addLog(`Actual Quantity cho ${position.side} ${position.symbol} là 0. Không thể tính TP/SL.`);
             await cancelOpenOrdersForSymbol(position.symbol, null, position.side); // Hủy lệnh cũ nếu có
             position.currentSLId = null; position.initialSLPrice = null; position.currentTPId = null; position.initialTPPrice = 0;
             return;
        }
        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;


        let newSLPrice, newTPPrice;
        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY';

        if (position.side === 'LONG') {
            newSLPrice = actualEntryPrice - priceChangeForSL;
            newTPPrice = actualEntryPrice + priceChangeForTP;
            newSLPrice = Math.floor(newSLPrice / tickSize) * tickSize;
            newTPPrice = Math.floor(newTPPrice / tickSize) * tickSize;
        } else { // SHORT
            newSLPrice = actualEntryPrice + priceChangeForSL;
            newTPPrice = actualEntryPrice - priceChangeForTP;
            newSLPrice = Math.ceil(newSLPrice / tickSize) * tickSize;
            newTPPrice = Math.ceil(newTPPrice / tickSize) * tickSize;
        }
        newSLPrice = parseFloat(newSLPrice.toFixed(pricePrecision));
        newTPPrice = parseFloat(newTPPrice.toFixed(pricePrecision));


        // Hủy TP/SL cũ và đặt lại
        await cancelOpenOrdersForSymbol(position.symbol, null, position.side);
        await sleep(500);

        // Đặt lệnh SL mới
        let placedSLOrderId = null;
        try {
             // Chỉ đặt SL nếu initialSLPrice của local object KHÔNG phải là null
             // (Lệnh lãi ban đầu có đòn bẩy cao đã hủy SL sẽ có initialSLPrice local = null)
             // Tuy nhiên, khi addPosition, initialSLPrice local cũng reset, cần cẩn thận.
             // Simple approach: Nếu position.side là lệnh lỗ (losingPos), LUÔN đặt SL. Nếu là lệnh lãi, chỉ đặt nếu cờ hasRemovedInitialSL là FALSE
             const isWinningPosition = (currentLongPosition && currentLongPosition.symbol === position.symbol && currentLongPosition.unrealizedPnl > 0) ||
                                      (currentShortPosition && currentShortPosition.symbol === position.symbol && currentShortPosition.unrealizedPnl > 0);
            const isLosingPosition = (currentLongPosition && currentLongPosition.symbol === position.symbol && currentLongPosition.unrealizedPnl < 0) ||
                                     (currentShortPosition && currentShortPosition.symbol === position.symbol && currentShortPosition.unrealizedPnl < 0);


            let shouldPlaceSL = false;
             // Nếu là lệnh lãi VÀ cờ removedInitialSL là false (tức là ban đầu nó có SL VÀ chưa bị hủy) HOẶC sau khi addPosition, nó lại được đặt SL
             if (isWinningPosition && !position.hasRemovedInitialSL) {
                 shouldPlaceSL = true;
             }
             // Nếu là lệnh lỗ, LUÔN đặt SL (vì lệnh lỗ luôn cần SL theo quy tắc TP=2*SL)
             if (isLosingPosition) {
                  shouldPlaceSL = true;
                  // Đặc biệt cho lệnh lỗ sau khi addPosition, SL cần được đặt lại
                 position.initialSLPrice = newSLPrice; // Cập nhật giá SL local object của lệnh lỗ
             }
            // Trường hợp khi chỉ còn 1 vị thế (ví dụ sau khi 1 lệnh khớp), vị thế đó có thể có PNL dương/âm.
            // Nếu chỉ còn 1 vị thế và nó là 'lãi' (TP khớp) --> TP khớp thì lệnh đã đóng hoàn toàn rồi.
            // Nếu chỉ còn 1 vị thế và nó là 'lỗ' (SL khớp) --> SL khớp thì lệnh đã đóng hoàn toàn rồi.
            // Trường hợp này chỉ xảy ra khi Bot resume với 1 vị thế duy nhất sót lại, HOẶC sau lỗi đóng nốt.
            // Logic quản lý SL phức tạp sau partial close cần dựa vào cờ hasAdjustedSL...

             // Luôn cố gắng đặt lại SL cho cả 2 lệnh sau addPosition hoặc khi resume
            //  let slTargetAfterAdjustment = newSLPrice;
            // // Kiểm tra nếu đang trong trạng thái điều chỉnh SL do partial close
            // // Lệnh lãi: Sau 6 lần đóng, SL cả 2 về price[1]. Sau 8 lần, SL lãi về price[4]
            // // Lệnh lỗ: Sau addPosition, SL về breakeven. Sau 6 lần đóng, SL cả 2 về price[1]
            // if(position.partialClosePrices && position.partialClosePrices.length > 0 && losingPos){
            //      const partialCloseCount = losingPos.nextPartialCloseLossIndex; // Số lần ATTEMPT đóng lỗ
            //      if(partialCloseCount >= 6 && winningPos.hasAdjustedSL6thClose) { // Nếu cờ lần 6 đã được đặt (nghĩa là điều chỉnh đã chạy)
            //          if (losingPos.partialClosePrices.length >= 2) slTargetAfterAdjustment = losingPos.partialClosePrices[1];
            //      }
            //       if(partialCloseCount >= 8 && winningPos.hasAdjustedSL8thClose && position.side === winningPos.side) { // Nếu cờ lần 8 đã được đặt VÀ đây là lệnh lãi
            //          if (losingPos.partialClosePrices.length >= 5) slTargetAfterAdjustment = losingPos.partialClosePrices[4];
            //      }
            // }
             // Reset SL/TP dựa trên giá vào trung bình mới VÀ số lượng mới.
             // QUAN TRỌNG: SL và TP luôn tính lại trên VỐN BAN ĐẦU, entry trung bình MỚI và QUANTITY MỚI.

             let finalSLPriceForOrder = newSLPrice;

             // Áp dụng giá SL từ partialClosePrices nếu đã đạt mốc 6 hoặc 8 (chỉ cho lệnh lãi)
             let winningPosLocal = (currentLongPosition && currentLongPosition.symbol === position.symbol && currentLongPosition.unrealizedPnl > 0) ? currentLongPosition : null;
             if (!winningPosLocal) { // Tìm winningPos từ 2 biến global
                if (currentLongPosition && currentShortPosition) { // Chỉ khi cả 2 tồn tại mới phân biệt lãi/lỗ
                   winningPosLocal = currentLongPosition.unrealizedPnl > 0 ? currentLongPosition : currentShortPosition.unrealizedPnl > 0 ? currentShortPosition : null;
                 } else if (currentLongPosition) winningPosLocal = currentLongPosition.unrealizedPnl > 0 ? currentLongPosition : null; // Nếu chỉ có 1 lệnh, check xem có lãi không
                 else if (currentShortPosition) winningPosLocal = currentShortPosition.unrealizedPnl > 0 ? currentShortPosition : null;
             }

             let losingPosLocal = null;
             if (currentLongPosition && currentShortPosition) { // Chỉ khi cả 2 tồn tại mới phân biệt lãi/lỗ
                losingPosLocal = currentLongPosition.unrealizedPnl < 0 ? currentLongPosition : currentShortPosition.unrealizedPnl < 0 ? currentShortPosition : null;
             } else if (currentLongPosition) losingPosLocal = currentLongPosition.unrealizedPnl < 0 ? currentLongPosition : null;
             else if (currentShortPosition) losingPosLocal = currentShortPosition.unrealizedPnl < 0 ? currentShortPosition : null;


            // Logic điều chỉnh SL dựa trên partialClosePrices chỉ áp dụng cho lệnh LÃI khi mốc đã ĐẠT.
             // Đối với lệnh LỖ, SL ban đầu/đặt lại sau addPosition được tính từ entry trung bình mới.
             let isCurrentPosWinning = false;
             if (position.side === 'LONG' && currentLongPosition?.unrealizedPnl > 0) isCurrentPosWinning = true;
             if (position.side === 'SHORT' && currentShortPosition?.unrealizedPnl > 0) isCurrentPosWinning = true;

            // Check mốc SL lần 6 cho CẢ HAI lệnh (Long & Short) dựa trên trạng thái của winningPos
            if (winningPosLocal && winningPosLocal.partialClosePrices && winningPosLocal.partialClosePrices.length >= 2 && winningPosLocal.hasAdjustedSL6thClose) {
                 finalSLPriceForOrder = losingPosLocal ? losingPosLocal.partialClosePrices[1] : newSLPrice; // Nếu losingPos bị đóng sớm, dùng newSLPrice ban đầu? Hoặc giá lúc đóng TP? Cần refine logic.
                 addLog(`Áp dụng SL từ mốc điều chỉnh lần 6 (${finalSLPriceForOrder}) cho lệnh ${position.side}.`);
            }

            // Check mốc SL lần 8 CHỈ CHO lệnh LÃI dựa trên trạng thái của winningPos
            // Lệnh lỗ được đóng hoàn toàn ở mốc này.
            if (winningPosLocal && winningPosLocal.partialClosePrices && winningPosLocal.partialClosePrices.length >= 5 && winningPosLocal.hasAdjustedSL8thClose && position.side === winningPosLocal.side) {
                 finalSLPriceForOrder = losingPosLocal ? losingPosLocal.partialClosePrices[4] : newSLPrice; // Nếu losingPos bị đóng sớm, dùng newSLPrice ban đầu?
                 addLog(`Áp dụng SL từ mốc điều chỉnh lần 8 (${finalSLPriceForOrder}) cho lệnh ${position.side}.`);
            }


            // Kiểm tra nếu SL mới là vô hiệu hoặc nằm sai hướng
            const isSLInvalid = (position.side === 'LONG' && finalSLPriceForOrder >= actualEntryPrice) || (position.side === 'SHORT' && finalSLPriceForOrder <= actualEntryPrice);
             if (isSLInvalid) {
                 addLog(`Cảnh báo: Giá SL tính toán (${finalSLPriceForOrder}) không hợp lệ (lớn hơn/bằng entry cho LONG, nhỏ hơn/bằng entry cho SHORT). Không đặt lệnh SL cho ${position.side}.`);
                 // set SL state to null? Maybe safer.
                 position.currentSLId = null;
                 position.initialSLPrice = null;
                 position.hasRemovedInitialSL = true;
            } else {

                const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: position.symbol,
                    side: orderSideToClose,
                    positionSide: position.side,
                    type: 'STOP_MARKET',
                    quantity: actualQuantity,
                    stopPrice: finalSLPriceForOrder, // Sử dụng giá SL đã điều chỉnh
                    closePosition: 'true',
                    newOrderRespType: 'FULL'
                });
                placedSLOrderId = slOrderResult.orderId;
                 position.initialSLPrice = finalSLPriceForOrder; // Cập nhật giá SL local object
                 position.currentSLId = placedSLOrderId; // Cập nhật ID lệnh SL mới
                position.hasRemovedInitialSL = false; // Nếu đặt lại SL thành công, cờ hủy ban đầu được reset
                addLog(`Đã đặt lại SL cho ${position.side} ${position.symbol} @ ${finalSLPriceForOrder.toFixed(pricePrecision)}. OrderId: ${slOrderResult.orderId}`);
             }

        } catch (slError) {
            addLog(`Lỗi đặt lại SL cho ${position.side} ${position.symbol}: ${slError.msg || slError.message}.`);
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
                await closePosition(position.symbol, position.quantity, `SL ${position.side} kích hoạt ngay sau điều chỉnh/mở thêm`, position.side);
                return;
            }
            // Nếu lỗi đặt SL, đặt SLId và initialSLPrice về null, và cờ hủy ban đầu thành true
             position.currentSLId = null;
             position.initialSLPrice = null;
            position.hasRemovedInitialSL = true;
        }
        await sleep(500);

        // Đặt lệnh TP mới (TP không bị ảnh hưởng bởi các mốc đóng một phần lỗ)
        let placedTPOrderId = null;
        try {
            // Lấy số lượng thực tế của vị thế trên sàn để đặt lệnh TP mới
            const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

             if (!currentPosOnBinance) {
                 addLog(`Vị thế ${position.side} không còn tồn tại trên Binance để cập nhật TP. Bỏ qua.`);
                 position.currentTPId = null;
                 return;
            }
             const actualQuantityTP = Math.abs(parseFloat(currentPosOnBinance.positionAmt));


            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: orderSideToClose,
                positionSide: position.side,
                type: 'TAKE_PROFIT_MARKET',
                quantity: actualQuantityTP, // Sử dụng số lượng hiện tại
                stopPrice: newTPPrice, // Giá TP được tính từ entry trung bình mới
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            placedTPOrderId = tpOrderResult.orderId;
            position.initialTPPrice = newTPPrice; // Cập nhật giá TP local object
             position.currentTPId = placedTPOrderId; // Cập nhật ID lệnh TP mới
            addLog(`Đã đặt lại TP cho ${position.side} ${position.symbol} @ ${newTPPrice.toFixed(pricePrecision)}. OrderId: ${tpOrderResult.orderId}`);
        } catch (tpError) {
            addLog(`Lỗi đặt lại TP cho ${position.side} ${position.symbol}: ${tpError.msg || tpError.message}.`);
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
                await closePosition(position.symbol, position.quantity, `TP ${position.side} kích hoạt ngay sau điều chỉnh/mở thêm`, position.side);
                return;
            }
            // Nếu lỗi đặt TP, đặt TPId về null
            position.currentTPId = null;
        }
        await sleep(500);


    } catch (error) {
        addLog(`Lỗi khi cập nhật TP/SL cho tổng vị thế ${position.symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi cập nhật TP/SL sau mở thêm.`);
            stopBotLogicInternal();
        }
    }
}

/**
 * Hàm hủy và đặt lại lệnh SL cho một vị thế.
 * LƯU Ý QUAN TRỌNG: Sẽ hủy SL cũ và đặt mới. KHÔNG HỦY TP.
 * @param {object} position - Vị thế cần điều chỉnh SL.
 * @param {number} targetSLPrice - Giá SL mục tiêu (hoặc null để chỉ hủy).
 */
async function updateStopLoss(position, targetSLPrice) {
    if (!position || !position.symbol) {
        addLog('updateStopLoss called with invalid position object.');
        return;
    }
    addLog(`Đang điều chỉnh SL cho lệnh ${position.side} ${position.symbol} về giá: ${targetSLPrice !== null ? targetSLPrice.toFixed(position.pricePrecision) : 'NULL'}.`);

    // Chỉ hủy lệnh SL hiện có của vị thế đó, đảm bảo hủy đúng positionSide
    if (position.currentSLId) {
        addLog(`Hủy lệnh SL cũ (${position.currentSLId}) cho ${position.side} ${position.symbol}.`);
        // Use try-catch here specifically for cancel, as Unknown Order (-2011) is expected if already triggered
        try {
            await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side);
            addLog(`Đã hủy lệnh ${position.currentSLId}.`);
        } catch (error) {
             // Ignore -2011 Unknown order - means it's already gone (filled/cancelled elsewhere)
             if (error.code !== -2011) {
                 addLog(`Lỗi khi hủy lệnh SL cũ (${position.currentSLId}): ${error.msg || error.message}`);
                 if (error instanceof CriticalApiError) throw error; // Re-throw critical errors
             } else {
                 addLog(`Lệnh SL cũ (${position.currentSLId}) không tồn tại hoặc đã khớp/hủy.`);
             }
        } finally {
            position.currentSLId = null;
            position.initialSLPrice = null; // Cập nhật trạng thái SL là null
            await sleep(500);
        }
    } else {
        addLog(`Không tìm thấy lệnh SL hiện có cho ${position.side} ${position.symbol} để hủy.`);
    }

    // Nếu targetSLPrice là null, chỉ hủy mà không đặt lại
    if (targetSLPrice === null) {
        addLog(`Đã hủy SL cho ${position.side} ${position.symbol}. Không đặt lại SL mới.`);
        // Cập nhật cờ đã hủy SL ban đầu nếu đây là lệnh lãi VÀ cờ đó chưa được đặt
        // if (position.unrealizedPnl > 0 && !position.hasRemovedInitialSL) { // Removed PNL check as it might be needed for manual adjustment too
        // Only set if not null already
        // Set flag only if this position is a winning position AND the flag wasn't already set true by initial logic
         let isCurrentPosWinning = false;
         if (currentLongPosition && currentLongPosition.symbol === position.symbol && currentLongPosition.unrealizedPnl > 0) isCurrentPosWinning = true;
         if (currentShortPosition && currentShortPosition.symbol === position.symbol && currentShortPosition.unrealizedPnl > 0) isCurrentPosWinning = true;

         if (isCurrentPosWinning && !position.hasRemovedInitialSL) {
            position.hasRemovedInitialSL = true;
             addLog(`Cờ 'hasRemovedInitialSL' cho lệnh lãi ${position.side} được đặt thành true.`);
         }

        return;
    }

    // --- Đặt lại lệnh SL mới ---
    const symbolDetails = await getSymbolDetails(position.symbol);
    if (!symbolDetails) {
        addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể điều chỉnh SL (đặt mới).`);
        // Set state to null as set failed
         position.currentSLId = null;
         position.initialSLPrice = null;
        position.hasRemovedInitialSL = true;
        return;
    }
    const { pricePrecision } = symbolDetails;

    try {
        const slOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        // Lấy số lượng thực tế của vị thế trên sàn để đặt lệnh SL mới
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) {
            addLog(`Vị thế ${position.side} không còn tồn tại trên Binance để cập nhật SL (đặt mới). Bỏ qua.`);
            position.currentSLId = null; // Đảm bảo trạng thái local object đúng
            position.initialSLPrice = null;
            position.hasRemovedInitialSL = true; // Flag as removed since we can't set a new one
            return;
        }

        // Check if new SL price is valid
         const actualEntryPrice = parseFloat(currentPosOnBinance.entryPrice);
        const isSLInvalid = (position.side === 'LONG' && targetSLPrice >= actualEntryPrice) || (position.side === 'SHORT' && targetSLPrice <= actualEntryPrice);
         if (isSLInvalid) {
             addLog(`Cảnh báo: Giá SL tính toán (${targetSLPrice.toFixed(pricePrecision)}) không hợp lệ (lớn hơn/bằng entry cho LONG, nhỏ hơn/bằng entry cho SHORT). Không đặt lệnh SL cho ${position.side}.`);
            // set SL state to null
             position.currentSLId = null;
             position.initialSLPrice = null;
             position.hasRemovedInitialSL = true;
             return; // Stop here if price is invalid
         }


        const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: slOrderSide,
            positionSide: position.side,
            type: 'STOP_MARKET',
            quantity: Math.abs(parseFloat(currentPosOnBinance.positionAmt)), // Sử dụng số lượng hiện tại trên sàn
            stopPrice: targetSLPrice,
            closePosition: 'true',
            newOrderRespType: 'FULL'
        });
        position.currentSLId = slOrderResult.orderId;
        position.initialSLPrice = targetSLPrice; // Cập nhật initialSLPrice (thực ra là current SL)
        // Sau khi đặt lại SL thành công, cờ hasRemovedInitialSL có thể được reset
        position.hasRemovedInitialSL = false; // Đặt lại cờ
        addLog(`Đã điều chỉnh SL cho ${position.side} ${position.symbol} @ ${targetSLPrice.toFixed(pricePrecision)}. OrderId: ${slOrderResult.orderId}`);
    } catch (slError) {
        addLog(`Lỗi điều chỉnh SL cho ${position.side} ${position.symbol}: ${slError.msg || slError.message}.`);
        if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
            addLog(`SL kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
            // Pass current actual quantity from local state or try to get from Binance if possible?
             const actualQtyFromLocal = position.quantity; // Use local state quantity for simplicity here
             await closePosition(position.symbol, actualQtyFromLocal, `SL kích hoạt ngay khi điều chỉnh`, position.side);
            return; // Bot might be stopped by closePosition if Critical Error
        }
        // Nếu lỗi đặt SL (không phải do kích hoạt ngay), đặt SLId và initialSLPrice về null, và cờ hủy ban đầu thành true
        position.currentSLId = null;
        position.initialSLPrice = null;
        position.hasRemovedInitialSL = true;
        if (slError instanceof CriticalApiError) { // Re-throw critical errors to stop bot
             addLog(`Bot dừng do lỗi API nghiêm trọng khi cố gắng đặt lại SL.`);
             stopBotLogicInternal(); // Ensure bot stops
             throw slError;
        }
    }
    await sleep(500);
}


/**
 * Hàm kiểm tra và quản lý vị thế đang mở. Đây là hàm chính chứa các logic phức tạp.
 * Chạy định kỳ để cập nhật trạng thái vị thế, đóng từng phần, điều chỉnh SL.
 */
const manageOpenPosition = async () => {
    // Nếu không còn vị thế nào hoặc interval đã được xóa (có thể do stopBotLogicInternal), dừng
    // Logic kiểm tra và scheduleNextMainCycle() được moved vào scheduleNextMainCycle
    if (!botRunning || (!currentLongPosition && !currentShortPosition)) {
         // Nếu bot đã dừng hoặc không còn vị thế, interval này nên được dọn dẹp ở nơi gọi nó (startBotLogicInternal/cleanup)
        if (positionCheckInterval) {
             clearInterval(positionCheckInterval);
             positionCheckInterval = null;
             addLog('Không còn vị thế mở và/hoặc bot dừng. Dừng kiểm tra định kỳ.');
         }
         // scheduleNextMainCycle sẽ kiểm tra lại sau khi positionCheckInterval dừng nếu botRunning=true
        return; // Thoát khỏi hàm định kỳ
    }

    if (isClosingPosition) { // Tránh xung đột nếu đang có lệnh đóng khác đang thực hiện
        // addLog('Đang trong quá trình đóng vị thế, bỏ qua quản lý vị thế.'); // Log này có thể gây spam
        return;
    }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        let hasActivePositionAfterSync = false; // Cờ để kiểm tra xem còn vị thế nào hoạt động KHÔNG ở 0 amt trên sàn không

        // Sync trạng thái local positions object với trạng thái thực tế trên Binance
        if (currentLongPosition) {
             const longPosOnBinance = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'LONG' && parseFloat(p.positionAmt) !== 0);
             if (!longPosOnBinance) { // Vị thế LONG đã đóng trên sàn (PNL=0 hoặc bị liquidate)
                  addLog(`Vị thế LONG ${TARGET_COIN_SYMBOL} đã đóng trên sàn (amount=0). Cập nhật bot state.`);
                  currentLongPosition = null;
                  // Logic đóng vị thế đối ứng sẽ được processTradeResult xử lý nếu là TP/SL chính
                  // Nếu không phải (ví dụ: thanh lý), cleanupAndResetCycle cần được gọi.
                  // Tốt nhất nên kiểm tra cuối hàm manageOpenPosition xem cả 2 đã null chưa.
             } else { // Vị thế LONG còn hoạt động trên sàn
                  currentLongPosition.unrealizedPnl = parseFloat(longPosOnBinance.unRealizedProfit);
                  currentLongPosition.currentPrice = parseFloat(longPosOnBinance.markPrice);
                  currentLongPosition.quantity = Math.abs(parseFloat(longPosOnBinance.positionAmt)); // Cập nhật lại số lượng thực tế
                   currentLongPosition.entryPrice = parseFloat(longPosOnBinance.entryPrice); // Cập nhật entryPrice trung bình
                   // Lấy giá TP/SL hiện tại trên sàn nếu state trong bot đang thiếu (ví dụ: khởi động lại bot giữa chừng)
                   if(!currentLongPosition.currentTPId || !currentLongPosition.currentSLId){
                         // Lấy lệnh đang chờ trên sàn chỉ 1 lần ở đây hoặc ở checkAndRecreateTPAndSL?
                         // checkAndRecreateTPAndSL đã có logic đó và được gọi sau mở lệnh / khởi động.
                         // Không cần lặp lại ở đây để tránh overhead. ManageOpenPosition chỉ nên xử lý dựa trên state hiện có.
                   }

                  hasActivePositionAfterSync = true; // Có vị thế LONG đang hoạt động
             }
        }

        if (currentShortPosition) {
            const shortPosOnBinance = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) !== 0);
             if (!shortPosOnBinance) { // Vị thế SHORT đã đóng trên sàn (PNL=0 hoặc bị liquidate)
                  addLog(`Vị thế SHORT ${TARGET_COIN_SYMBOL} đã đóng trên sàn (amount=0). Cập nhật bot state.`);
                  currentShortPosition = null;
             } else { // Vị thế SHORT còn hoạt động trên sàn
                 currentShortPosition.unrealizedPnl = parseFloat(shortPosOnBinance.unRealizedProfit);
                 currentShortPosition.currentPrice = parseFloat(shortPosOnBinance.markPrice);
                 currentShortPosition.quantity = Math.abs(parseFloat(shortPosOnBinance.positionAmt)); // Cập nhật lại số lượng thực tế
                 currentShortPosition.entryPrice = parseFloat(shortPosOnBinance.entryPrice); // Cập nhật entryPrice trung bình

                 hasActivePositionAfterSync = true; // Có vị thế SHORT đang hoạt động
            }
        }


        // Nếu không còn vị thế hoạt động nào sau khi cập nhật từ sàn, dừng interval và dọn dẹp (nếu chưa).
        // Dọn dẹp được trigger bởi processTradeResult hoặc checkAndHandleRemainingPosition.
        // Tuy nhiên, nếu cả 2 bị liquidated cùng lúc, có thể cần logic ở đây.
        if (!hasActivePositionAfterSync) {
             addLog(`Đã xác nhận không còn vị thế mở nào cho ${TARGET_COIN_SYMBOL} trên sàn sau khi sync.`);
             if (currentLongPosition || currentShortPosition) {
                 // Đây là trường hợp hiếm, có thể state trong bot sai lệch với sàn
                 // Đảm bảo state local cũng reset và cleanup
                 addLog(`State trong bot (${!!currentLongPosition} LONG, ${!!currentShortPosition} SHORT) không khớp sàn. Force reset state.`);
                 currentLongPosition = null;
                 currentShortPosition = null;
             }
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
             // Call cleanup để đảm bảo mọi thứ sạch sẽ và lên lịch chu kỳ mới
            await cleanupAndResetCycle(TARGET_COIN_SYMBOL); // Dọn dẹp & Lên lịch chu kỳ mới
            return; // Thoát khỏi hàm
        }

        // --- Logic đóng từng phần và điều chỉnh SL chỉ chạy khi CÓ CẢ HAI VỊ THẾ TỒN TẠI TRÊN SÀN ---
        if (currentLongPosition && currentShortPosition) {

            // --- Xác định lệnh lãi (winningPos) và lệnh lỗ (losingPos) ---
            let winningPos = null;
            let losingPos = null;

            if (currentLongPosition.unrealizedPnl > 0 && currentShortPosition.unrealizedPnl < 0) { // LONG lãi, SHORT lỗ
                winningPos = currentLongPosition;
                losingPos = currentShortPosition;
            } else if (currentShortPosition.unrealizedPnl > 0 && currentLongPosition.unrealizedPnl < 0) { // SHORT lãi, LONG lỗ
                winningPos = currentShortPosition;
                losingPos = currentLongPosition;
            } else if (currentLongPosition.unrealizedPnl === 0 && currentShortPosition.unrealizedPnl === 0) {
                 // Cả hai đang ở hòa vốn
                // addLog('Cả hai vị thế đều ở hòa vốn. Bỏ qua logic đóng từng phần và điều chỉnh SL.');
                 return; // Không làm gì nếu cả hai hòa vốn
            } else if (currentLongPosition.unrealizedPnl > 0 && currentShortPosition.unrealizedPnl > 0) {
                 addLog('Cảnh báo: Cả hai vị thế đang lãi? Kiểm tra lại.'); // Hedge mode, một lệnh lãi thì lệnh kia phải lỗ
                 return;
            } else if (currentLongPosition.unrealizedPnl < 0 && currentShortPosition.unrealizedPnl < 0) {
                 addLog('Cảnh báo: Cả hai vị thế đang lỗ. Bỏ qua logic đóng từng phần/SL.'); // Bỏ qua logic nếu cả hai lỗ
                 return;
            } else {
                 addLog('Vị thế hỗn hợp hoặc PNL chưa cập nhật. Bỏ qua logic đóng từng phần/SL.'); // Trường hợp khác
                 return;
            }


            // Nếu đến đây, chắc chắn có một lệnh lãi và một lệnh lỗ
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100; // Tính lãi % trên vốn BAN ĐẦU của lệnh lãi

            // YÊU CẦU: Lệnh lãi chỉ có TP, không SL. -> Hủy SL ban đầu của lệnh lãi.
            // Chỉ kiểm tra và hủy nếu lệnh lãi có SL ban đầu được lưu (currentSLId)
            // Và cờ hasRemovedInitialSL chưa được set true
             if (winningPos.currentSLId && !winningPos.hasRemovedInitialSL) {
                addLog(`Lệnh ${winningPos.side} đang lãi. Kiểm tra để hủy SL ban đầu nếu đã đủ lãi.`);
                // Chỉ hủy khi lãi trên 0.5% vốn ban đầu để tránh jitter quanh hòa vốn
                 if (currentProfitPercentage > 0.5) {
                     await updateStopLoss(winningPos, null); // Hủy SL mà không đặt lại
                     // Cờ hasRemovedInitialSL sẽ được set true bên trong updateStopLoss
                     addLog(`Đã hủy SL ban đầu cho lệnh lãi ${winningPos.side} (PNL ${currentProfitPercentage.toFixed(2)}%).`);
                 } else {
                     addLog(`Lệnh lãi ${winningPos.side} (PNL ${currentProfitPercentage.toFixed(2)}%) chưa đủ điều kiện hủy SL ban đầu.`);
                 }
             }

            // Logic đóng từng phần lệnh lỗ (dựa trên % lãi của lệnh lãi)
            // nextPartialCloseLossIndex bắt đầu từ 0
            const currentLossCloseIndex = losingPos.nextPartialCloseLossIndex; // Sử dụng index của lệnh lỗ
            const nextLossCloseLevel = losingPos.partialCloseLossLevels[currentLossCloseIndex];


            if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel && losingPos.nextPartialCloseLossIndex < 8) { // Đảm bảo index không vượt quá 7
                // Đảm bảo lệnh lỗ vẫn còn đủ số lượng để đóng 10% initialQuantity
                 const symbolInfo = await getSymbolDetails(losingPos.symbol);
                 if (!symbolInfo) {
                    addLog(`Lỗi lấy symbol info cho lệnh lỗ ${losingPos.symbol}. Không thể đóng từng phần.`);
                    return;
                 }
                // 10% khối lượng ban đầu của lệnh lỗ
                 let quantityToAttemptClose = losingPos.initialQuantity * 0.10;
                 quantityToAttemptClose = Math.floor(quantityToAttemptClose / symbolInfo.stepSize) * symbolInfo.stepSize;
                 quantityToAttemptClose = parseFloat(quantityToAttemptClose.toFixed(symbolInfo.quantityPrecision));

                 const actualLosingPositionQuantity = Math.abs(parseFloat(losingPosOnBinance.positionAmt));


                 if (actualLosingPositionQuantity >= quantityToAttemptClose && quantityToAttemptClose > 0) {
                     addLog(`Lệnh ${winningPos.side} đạt mốc lãi ${nextLossCloseLevel}%. Đang đóng ${10}% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ, lần thứ ${currentLossCloseIndex + 1}).`);
                     // percentageOfInitialQuantity = 10 for each step
                     await closePartialPosition(losingPos, 10, 'LOSS');
                    // Index được tăng trong closePartialPosition khi thành công
                     // losingPos.nextPartialCloseLossIndex++; // Logic moved to closePartialPosition? Check it.
                    // It's not increased in closePartialPosition currently. It should be increased *after* attempting the close.
                     losingPos.nextPartialCloseLossIndex++; // Tăng index cho lệnh lỗ sau khi attempt đóng một phần
                     winningPos.nextPartialCloseLossIndex = losingPos.nextPartialCloseLossIndex; // Sync index giữa 2 lệnh


                 } else {
                     if(actualLosingPositionQuantity > 0){
                         addLog(`Không đủ số lượng (${actualLosingPositionQuantity}) hoặc số lượng quá nhỏ (${quantityToAttemptClose.toFixed(symbolInfo.quantityPrecision)}) để đóng 10% khối lượng ban đầu cho lệnh lỗ ${losingPos.side}. Bỏ qua đóng từng phần lần ${currentLossCloseIndex + 1}.`);
                     } else {
                          addLog(`Lệnh lỗ ${losingPos.side} đã đóng hoàn toàn (actual Qty 0). Bỏ qua đóng từng phần.`);
                     }
                 }
             } else if (losingPos.nextPartialCloseLossIndex >= 8) {
                 // Đã đạt hoặc vượt qua 8 lần đóng một phần, không đóng từng phần nữa.
                 // addLog('Đã attempt đóng 8 lần lệnh lỗ. Bỏ qua đóng từng phần.'); // Tránh log spam
             }


            // --- Logic điều chỉnh SL khi đạt ngưỡng đóng một phần lệnh lỗ ---
            // Dựa trên `nextPartialCloseLossIndex` (đã đồng bộ giữa winningPos và losingPos)

            // YÊU CẦU: Sau 6 lần đóng 1 phần lệnh lỗ. Rời sl cả 2 lệnh long short về giá lúc đóng 1 phần lệnh lỗ lần thứ 2 (index 1).
            // Cờ hasAdjustedSL6thClose đảm bảo chỉ chạy một lần
            if (winningPos.nextPartialCloseLossIndex >= 6 && !winningPos.hasAdjustedSL6thClose) {
                 // partialClosePrices[1] lưu giá entry của lệnh lỗ tại thời điểm đóng phần thứ 2 (index 1)
                 // Đảm bảo có ít nhất 2 giá trong partialClosePrices (index 0 và 1)
                 if (losingPos.partialClosePrices.length >= 2) {
                    const slTargetPrice = losingPos.partialClosePrices[1]; // Index 1 là lần đóng thứ 2 (0-indexed)
                     addLog(`Đạt mốc đóng lỗ lần ${winningPos.nextPartialCloseLossIndex}. Điều chỉnh SL của cả 2 lệnh về giá entry lệnh lỗ lúc đóng lỗ lần 2 (${slTargetPrice.toFixed(symbolDetails.pricePrecision)}).`);

                     // Chỉ điều chỉnh SL nếu vị thế còn tồn tại trong bot state (tránh lỗi null)
                    if (currentLongPosition) {
                        // Update local state before API call for more accurate log message
                        if (currentLongPosition.currentSLId) addLog(`Cancelling SL ${currentLongPosition.currentSLId} for LONG before adjustment.`);
                         await updateStopLoss(currentLongPosition, slTargetPrice);
                    } else {
                        addLog(`Lệnh LONG không tồn tại. Bỏ qua điều chỉnh SL cho LONG.`);
                    }

                     if (currentShortPosition) {
                         if (currentShortPosition.currentSLId) addLog(`Cancelling SL ${currentShortPosition.currentSLId} for SHORT before adjustment.`);
                         await updateStopLoss(currentShortPosition, slTargetPrice);
                     } else {
                          addLog(`Lệnh SHORT không tồn tại. Bỏ qua điều chỉnh SL cho SHORT.`);
                     }

                     // Đặt cờ cho lệnh lãi sau khi thực hiện điều chỉnh SL cho cả hai lệnh
                    winningPos.hasAdjustedSL6thClose = true;

                 } else {
                     addLog(`Cảnh báo: Không đủ dữ liệu partialClosePrices (${losingPos.partialClosePrices.length} giá) để điều chỉnh SL lần 6 (chưa có giá đóng lỗ lần 2).`);
                 }
             }


            // YÊU CẦU: Khi 8 lần đóng 1 phần lệnh lỗ => đóng lệnh lỗ và rời sl lệnh lãi về giá lần đóng 1 phần thứ 5.
            // (Lệnh lỗ đã được attempt đóng hoàn toàn ở logic trên, nên chỉ cần điều chỉnh SL lệnh lãi)
            // Cờ hasAdjustedSL8thClose đảm bảo chỉ chạy một lần
            // Điều này xảy ra sau khi lệnh lỗ đã bị attempt đóng 8 lần (index >= 8)
            if (winningPos.nextPartialCloseLossIndex >= 8 && !winningPos.hasAdjustedSL8thClose) {
                // Lệnh lỗ đã bị attempt đóng hoàn toàn, kiểm tra lại trạng thái trên sàn lần cuối.
                 const actualLosingPositionQuantity = Math.abs(parseFloat(losingPosOnBinance?.positionAmt || '0'));

                 // Điều chỉnh SL lệnh lãi CHỈ KHI Lệnh Lãi vẫn còn VÀ Lệnh Lỗ đã được đóng hoặc có qty rất nhỏ.
                if (winningPos && (losingPos === null || actualLosingPositionQuantity < (losingPos.initialQuantity * 0.01)) ) { // Cho phép 1% lượng sót lại do làm tròn

                     // partialClosePrices[4] lưu giá entry của lệnh lỗ tại thời điểm đóng phần thứ 5 (index 4)
                     // Đảm bảo có ít nhất 5 giá trong partialClosePrices (index 0 đến 4)
                     if (losingPos.partialClosePrices.length >= 5) {
                        const slTargetPrice = losingPos.partialClosePrices[4]; // Index 4 là lần đóng thứ 5 (0-indexed)
                         addLog(`Đạt mốc đóng lỗ lần ${winningPos.nextPartialCloseLossIndex}. Lệnh lỗ đã/đang được đóng hoàn toàn. Đang điều chỉnh SL của lệnh lãi ${winningPos.side} về giá entry lệnh lỗ lúc đóng lỗ lần 5 (${slTargetPrice.toFixed(symbolDetails.pricePrecision)}).`);
                         await updateStopLoss(winningPos, slTargetPrice);
                         winningPos.hasAdjustedSL8thClose = true;
                     } else {
                         addLog(`Cảnh báo: Không đủ dữ liệu partialClosePrices (${losingPos.partialClosePrices.length} giá) để điều chỉnh SL lệnh lãi lần 8 (chưa có giá đóng lỗ lần 5).`);
                     }
                } else if (winningPos) {
                    addLog(`Đạt mốc đóng lỗ lần ${winningPos.nextPartialCloseLossIndex}, nhưng lệnh lỗ ${losingPos.side} vẫn còn lượng đáng kể (${actualLosingPositionQuantity}). Chờ đóng hết.`);
                }
            }

             // Logic "khi lệnh lãi chạm từ mốc đóng 1 phần trở lên và lệnh lãi về 0% => mở thêm những phần đã đóng của lệnh lỗ"
             // Chỉ chạy khi có cả hai lệnh, lệnh lãi đã từng attempt đóng lỗ (winningPos.nextPartialCloseLossIndex > 0),
             // lệnh lãi gần 0% lãi, VÀ lệnh lỗ đã từng bị đóng một phần (losingPos.closedQuantity > 0).
             // Và chỉ thực hiện trước mốc 8 lần đóng phần lỗ (nextPartialCloseLossIndex <= 7)
             if (winningPos && losingPos && winningPos.nextPartialCloseLossIndex > 0 && winningPos.nextPartialCloseLossIndex <= 7) {
                  const currentWinningProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;

                  // Kiểm tra xem có số lượng đã đóng từng phần cần cân bằng lại không
                 // losingPos.closedQuantity được cập nhật trong closePartialPosition.
                 // Cần sync losingPos.closedQuantity với Binance position risk History? Có vẻ phức tạp.
                 // Giả định losingPos.closedQuantity state là đúng sau các cuộc gọi API closePartialPosition
                 if (currentWinningProfitPercentage <= 0.1 && losingPos.closedQuantity > 0) { // 0.1% threshold
                    addLog(`Lệnh ${winningPos.side} đã attempt đóng từng phần lỗ (tới lần ${winningPos.nextPartialCloseLossIndex}) và lãi trở về 0% (${currentWinningProfitPercentage.toFixed(2)}%). Đang mở thêm ${losingPos.closedQuantity.toFixed(losingPos.quantityPrecision)} khối lượng cho lệnh ${losingPos.side} để cân bằng.`);
                    await addPosition(losingPos, losingPos.closedQuantity, 'Cân bằng lại lệnh lỗ');
                    // Ghi chú: Việc reset trạng thái đóng một phần/SL adjustment đã được thực hiện trong hàm `addPosition`.
                 }
             }


        } else {
            // Trường hợp chỉ còn 1 vị thế (sau khi lệnh đối ứng TP/SL khớp, hoặc do liquidate/lỗi khác)
            // manageOpenPosition vẫn chạy để sync state local.
             if (!currentLongPosition && !currentShortPosition) {
                // Đã được xử lý ở đầu hàm: interval sẽ dừng, cleanup sẽ chạy, schedule mới sẽ gọi.
             } else {
                 // Chỉ còn 1 vị thế. Đảm bảo SL của vị thế còn lại đang active.
                 // Ví dụ: Long lãi, Short lỗ -> Long TP khớp -> Short còn lại -> manageOpenPosition chạy, Short là position còn lại -> Check Short.
                 // Ví dụ: Long lãi, Short lỗ -> Short SL khớp -> Long còn lại -> manageOpenPosition chạy, Long là position còn lại -> Check Long.

                 const remainingPos = currentLongPosition || currentShortPosition;
                 if (remainingPos) {
                    addLog(`Chỉ còn 1 vị thế: ${remainingPos.side}. Đảm bảo lệnh TP/SL còn hiệu lực nếu có.`);
                    // Re-create TP/SL if missing for the remaining position.
                    await checkAndRecreateTPAndSL(remainingPos);
                 }
             }
        }


    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở cho ${TARGET_COIN_SYMBOL}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế.`);
             stopBotLogicInternal();
             // Lên lịch khởi động lại nếu có lỗi API nghiêm trọng
             if (!retryBotTimeout) {
                                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('Thử khởi động lại bot...');
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, ERROR_RETRY_DELAY_MS);
                            }
        } else {
             // Các lỗi không nghiêm trọng trong manageOpenPosition không cần dừng bot, chỉ cần log.
             // Ví dụ: Lỗi mạng tạm thời khi get position risk, hoặc lỗi hủy lệnh đơn lẻ (-2011)
        }
    }
};

/**
 * Hàm lên lịch chu kỳ chính của bot (runTradingLogic) sau một khoảng thời gian.
 * @returns {void}
 */
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét.');
        return;
    }

    clearTimeout(nextScheduledCycleTimeout); // Clear bất kỳ timeout đang chờ nào

    // Kiểm tra lại trạng thái vị thế cuối cùng trước khi quyết định làm gì
     // Dùng API call để chắc chắn
     let hasActivePosition = false;
     try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);
        if (positionsOnBinance.length > 0) {
             hasActivePosition = true;
             addLog(`Tìm thấy ${positionsOnBinance.length} vị thế đang mở trên sàn cho ${TARGET_COIN_SYMBOL}.`);
             // Đồng bộ lại trạng thái local position object nếu nó sai lệch?
             // Hàm manageOpenPosition làm điều này tốt hơn.
             // Cần đảm bảo positionCheckInterval đang chạy.
             if (!positionCheckInterval && botRunning) {
                 addLog('Có vị thế mở trên sàn nhưng interval kiểm tra đang dừng. Khởi động lại interval.');
                 positionCheckInterval = setInterval(async () => {
                    if (botRunning && (currentLongPosition || currentShortPosition)) { // Use local state for condition check in interval loop
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
                    } else if ((!currentLongPosition && !currentShortPosition) && positionCheckInterval){
                        // Dừng interval nếu không còn vị thế nào trong local state
                         addLog('Local state không có vị thế nào. Dừng interval kiểm tra.');
                         clearInterval(positionCheckInterval);
                         positionCheckInterval = null;
                         if(botRunning) scheduleNextMainCycle(); // Schedule new main cycle if bot still running
                    }
                }, 5000);
            }
        } else {
            // Không có vị thế nào trên sàn, kiểm tra state local
             addLog(`Không có vị thế mở trên sàn cho ${TARGET_COIN_SYMBOL}.`);
            if (currentLongPosition || currentShortPosition) {
                // State local đang sai lệch với sàn. Reset local state.
                addLog(`State local (${!!currentLongPosition} LONG, ${!!currentShortPosition} SHORT) không khớp sàn. Force reset local state.`);
                currentLongPosition = null;
                currentShortPosition = null;
                // Đảm bảo interval kiểm tra vị thế dừng nếu có.
                 if (positionCheckInterval) {
                     clearInterval(positionCheckInterval);
                     positionCheckInterval = null;
                 }
            }
             // Nếu không có vị thế nào cả trên sàn và trong bot state
            addLog(`Lên lịch chu kỳ giao dịch tiếp theo (mở lệnh mới) sau 2 giây...`);
            nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
        }
     } catch (error) {
         addLog(`Lỗi khi kiểm tra vị thế trên sàn trước khi schedule chu kỳ mới: ${error.msg || error.message}`);
         // Nếu lỗi API nghiêm trọng, dừng bot.
         if (error instanceof CriticalApiError) {
              addLog(`Bot dừng do lỗi API nghiêm trọng khi kiểm tra vị thế.`);
              stopBotLogicInternal(); // stopBotLogicInternal sẽ tự schedule retry
         } else {
             // Lỗi không nghiêm trọng, thử lại việc kiểm tra vị thế sau 5s.
              addLog(`Đợi 5 giây trước khi thử kiểm tra vị thế lại và schedule chu kỳ mới.`);
              nextScheduledCycleTimeout = setTimeout(scheduleNextMainCycle, 5000);
         }
     }
}

// --- HÀM CHO WEBSOCKET LISTENKEY VÀ KẾT NỐI ---

/**
 * Lấy listenKey mới từ Binance để mở User Data Stream.
 * @returns {Promise<string|null>} ListenKey hoặc null nếu lỗi.
 */
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
         // Ném lỗi để gọi startBotLogicInternal có thể catch và xử lý retry nếu cần
         if (error instanceof CriticalApiError) {
              throw error;
         }
        return null; // Trả về null cho lỗi không nghiêm trọng
    }
}

/**
 * Gửi yêu cầu làm mới listenKey để giữ kết nối User Data Stream hoạt động.
 */
async function keepAliveListenKey() {
    if (!listenKey) {
        addLog("Không có listenKey để làm mới.");
        // Nếu không có key, cố gắng lấy key mới
         try {
            listenKey = await getListenKey();
            if (listenKey) {
                setupUserDataStream(listenKey);
            } else {
                 addLog("Không thể lấy listenKey mới khi làm mới. Sẽ thử lại sau.");
             }
         } catch(e) {
              addLog(`Thêm lỗi khi cố gắng lấy listenKey mới trong keepAlive: ${e.message}`);
         }
        return;
    }
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: listenKey });
         // addLog('Đã làm mới listenKey.'); // Log này có thể gây spam log
    } catch (error) {
        addLog(`Lỗi khi làm mới listenKey: ${error.msg || error.message}`);
        // Nếu lỗi nghiêm trọng khi làm mới (ví dụ: listenKey hết hạn -1000, -1125)
        if (error.code === -1000 || error.code === -1125) {
            addLog(`ListenKey lỗi (${error.code}). Cố gắng lấy listenKey mới và kết nối lại.`);
             // Dừng interval làm mới cũ
             if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
             listenKeyRefreshInterval = null;
            userDataWs?.close(); // Đóng kết nối WS hiện tại
            userDataWs = null;

            // Thử lấy key mới và setup stream
            try {
                listenKey = await getListenKey(); // getListenKey sẽ throw CriticalApiError nếu key/secret sai
                if (listenKey) {
                    setupUserDataStream(listenKey);
                } else {
                    addLog("Không thể lấy listenKey mới sau lỗi làm mới nghiêm trọng. Sẽ thử lại theo retry loop chính.");
                }
            } catch (e) {
                addLog(`Thêm lỗi khi cố gắng lấy listenKey mới sau lỗi làm mới: ${e.message}`);
                // CriticalApiError từ getListenKey sẽ được propagate
                 if(e instanceof CriticalApiError) throw e; // Propagate để startBotLogicInternal xử lý retry bot
            }
        } else if (error instanceof CriticalApiError) {
             // Lỗi API nghiêm trọng khác
            throw error; // Propagate để startBotLogicInternal xử lý retry bot
        }
         // Ignore other errors for keepAlive, the reconnect logic on 'error' or 'close' will handle
    }
}

/**
 * Thiết lập kết nối WebSocket cho dữ liệu thị trường (Mark Price).
 * @param {string} symbol - Cặp giao dịch.
 */
function setupMarketDataStream(symbol) {
    if (!botRunning) { // Không setup nếu bot dừng
        addLog('Bot dừng. Hủy thiết lập Market Data Stream.');
        if (marketWs) {
             marketWs.close();
             marketWs = null;
         }
        return;
    }

    if (marketWs) { // Đóng kết nối cũ nếu có
        addLog('Đóng kết nối Market WebSocket cũ...');
        marketWs.close();
        marketWs = null;
    }

    // Đảm bảo symbol được định dạng đúng cho stream (lowercase)
    const streamSymbol = symbol.toLowerCase();
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${streamSymbol}@markPrice@1s`;

    addLog(`Kết nối Market WebSocket: ${streamUrl}`);
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => {
        addLog(`Market WebSocket cho ${symbol} đã kết nối.`);
    };

    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // Cập nhật currentMarketPrice nếu nhận được dữ liệu Mark Price cho đúng symbol
            // Binance returns symbol in UPPERCASE in streams
            if (data.e === 'markPriceUpdate' && data.s === TARGET_COIN_SYMBOL.toUpperCase()) {
                const newPrice = parseFloat(data.p);
                 // Chỉ cập nhật nếu giá thực sự thay đổi hoặc khác null ban đầu
                 if (currentMarketPrice === null || newPrice !== currentMarketPrice) {
                    currentMarketPrice = newPrice;
                     // Cập nhật giá hiện tại cho các vị thế đang theo dõi (lưu ý đây là async call, cần cẩn trọng nếu dùng trong loop)
                     // managedOpenPosition định kỳ đã sync price, update trực tiếp vào local state là ok.
                    if (currentLongPosition) currentLongPosition.currentPrice = currentMarketPrice;
                    if (currentShortPosition) currentShortPosition.currentPrice = currentMarketPrice;
                 }
            }
        } catch (e) {
            addLog(`Lỗi phân tích cú pháp Market WebSocket message: ${e.message}`);
        }
    };

    marketWs.onerror = (error) => {
        addLog(`Market WebSocket lỗi cho ${symbol}: ${error.message}.`);
        marketWs = null; // Reset object
        if (botRunning) { // Chỉ kết nối lại nếu bot đang chạy
             addLog("Đang thử kết nối lại Market WebSocket sau 5 giây...");
            setTimeout(() => setupMarketDataStream(symbol), 5000);
        } else {
             addLog("Bot dừng. Hủy kết nối lại Market WebSocket.");
        }
    };

    marketWs.onclose = (event) => {
        addLog(`Market WebSocket cho ${symbol} đã đóng. Code: ${event.code}, Reason: ${event.reason}.`);
        marketWs = null; // Reset object
        if (botRunning) { // Chỉ kết nối lại nếu bot đang chạy
            addLog("Đang thử kết nối lại Market WebSocket sau 5 giây...");
            setTimeout(() => setupMarketDataStream(symbol), 5000);
        } else {
             addLog("Bot dừng. Hủy kết nối lại Market WebSocket.");
        }
    };
}

/**
 * Thiết lập kết nối WebSocket cho User Data Stream.
 * @param {string} key - ListenKey.
 */
function setupUserDataStream(key) {
    if (!botRunning) { // Không setup nếu bot dừng
         addLog('Bot dừng. Hủy thiết lập User Data Stream.');
         if (userDataWs) {
             userDataWs.close();
             userDataWs = null;
         }
         if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
         listenKeyRefreshInterval = null;
        return;
    }

    if (userDataWs) { // Đóng kết nối cũ nếu có
        addLog('Đóng kết nối User Data WebSocket cũ...');
        userDataWs.close();
        userDataWs = null;
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
    }

    if (!key) {
         addLog("Không có listenKey để thiết lập User Data WebSocket. Hủy thiết lập.");
         return;
    }

    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${key}`;
    addLog(`Kết nối User Data WebSocket: ${streamUrl}`);
    userDataWs = new WebSocket(streamUrl);

    userDataWs.onopen = () => {
        addLog('User Data WebSocket đã kết nối.');
        // Bắt đầu interval để làm mới listenKey
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 1800000); // 30 phút
    };

    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'ORDER_TRADE_UPDATE') { // Xử lý sự kiện lệnh khớp hoặc lệnh mới/hủy
                const order = data.o;
                // Chỉ xử lý cho TARGET_COIN_SYMBOL
                if (order.s === TARGET_COIN_SYMBOL.toUpperCase()) { // So sánh với UPPERCASE
                    if (order.X === 'FILLED') {
                        // processTradeResult chỉ xử lý nếu PNL != 0, nhưng lệnh mở/đóng 1 phần PNL=0 cũng cần được log.
                        // AddLog here for all FILLED orders related to the symbol.
                         addLog(`Phát hiện lệnh khớp FILLED. Symbol: ${order.s}, Side: ${order.S}, Qty: ${order.q}, PNL: ${order.rp}, OrderId: ${order.i}, ClientOrderId: ${order.c}, Status: ${order.X}, PositionSide: ${order.ps}, ReduceOnly: ${order.R}, AvgPrice: ${order.ap}`);
                         // Call processTradeResult for filled orders
                         await processTradeResult(order);

                    } else if (order.X === 'NEW') {
                         // Log lệnh mới được đặt (TP/SL)
                        // addLog(`Lệnh mới ${order.i} (${order.o}, ${order.ps}) được đặt. Status: NEW, Price: ${order.p || order.ap || order.sp}`); // Log này có thể gây spam

                    } else if (order.X === 'CANCELED') {
                        addLog(`Lệnh ${order.i} (${order.o}, ${order.ps}) đã bị HỦY.`);
                        // Có thể cần logic để cập nhật currentTPId/currentSLId trong bot state nếu lệnh bị hủy không mong muốn
                        if (currentLongPosition?.currentSLId === order.i) currentLongPosition.currentSLId = null;
                        if (currentLongPosition?.currentTPId === order.i) currentLongPosition.currentTPId = null;
                        if (currentShortPosition?.currentSLId === order.i) currentShortPosition.currentSLId = null;
                        if (currentShortPosition?.currentTPId === order.i) currentShortPosition.currentTPId = null;

                    } else if (order.X === 'EXPIRED') {
                        addLog(`Lệnh ${order.i} (${order.o}, ${order.ps}) đã HẾT HẠN.`);
                         // Cập nhật state tương tự CANCELED
                         if (currentLongPosition?.currentSLId === order.i) currentLongPosition.currentSLId = null;
                         if (currentLongPosition?.currentTPId === order.i) currentLongPosition.currentTPId = null;
                         if (currentShortPosition?.currentSLId === order.i) currentShortPosition.currentSLId = null;
                         if (currentShortPosition?.currentTPId === order.i) currentShortPosition.currentTPId = null;

                    } else if (order.X === 'TRADE') {
                         // Đây là sự kiện Trade, cũng chứa info tương tự FILLED, có thể bỏ qua để tránh lặp log với FILLED
                         // addLog(`Phát hiện TRADE event: ${JSON.stringify(order)}`);
                    }
                }

            } else if (data.e === 'ACCOUNT_UPDATE') {
                // Xử lý cập nhật số dư hoặc vị thế nếu cần
                // addLog('Nhận ACCOUNT_UPDATE'); // Log này có thể gây spam, chỉ log nếu cần thiết

            } else if (data.e === 'listStatus') {
                 // Xử lý sự kiện listOrder nếu có dùng OCO hoặc Batch orders
                 addLog(`Nhận listStatus: ${JSON.stringify(data)}`);
            }
        } catch (e) {
            addLog(`Lỗi phân tích cú pháp User Data WebSocket message: ${e.message}`);
        }
    };

    userDataWs.onerror = (error) => {
        addLog(`User Data WebSocket lỗi: ${error.message}.`);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
        userDataWs = null; // Reset object
        if (botRunning) { // Chỉ kết nối lại nếu bot đang chạy
             addLog("Đang thử kết nối lại User Data Stream sau 5 giây...");
            setTimeout(async () => {
                try {
                    listenKey = await getListenKey(); // Lấy listenKey mới
                    if (listenKey) {
                         setupUserDataStream(listenKey);
                         addLog("Đã kết nối lại User Data Stream.");
                    } else {
                         addLog("Không thể lấy listenKey mới sau lỗi User Data WebSocket. User Data Stream không khả dụng.");
                         // Bot sẽ tiếp tục chạy dựa trên REST API và Market Stream, nhưng cập nhật PNL/xử lý trade sẽ trễ hoặc lỗi.
                    }
                } catch (e) {
                    addLog(`Thêm lỗi khi cố gắng lấy listenKey mới và kết nối lại User Data Stream: ${e.message}`);
                    // Nếu CriticalApiError, startBotLogicInternal sẽ xử lý retry bot.
                     if(e instanceof CriticalApiError) throw e; // Propagate error
                }
            }, 5000);
        } else {
             addLog("Bot dừng. Hủy kết nối lại User Data WebSocket.");
        }
    };

    userDataWs.onclose = (event) => {
        addLog(`User Data WebSocket đã đóng. Code: ${event.code}, Reason: ${event.reason}.`);
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
        userDataWs = null; // Reset object
        listenKey = null; // Clear listenKey khi stream đóng

        if (botRunning) { // Chỉ kết nối lại nếu bot đang chạy
             addLog("Đang thử kết nối lại User Data Stream sau 5 giây...");
             // Tương tự lỗi, cố gắng lấy key mới và kết nối lại
            setTimeout(async () => {
                try {
                    listenKey = await getListenKey(); // Lấy listenKey mới
                    if (listenKey) {
                         setupUserDataStream(listenKey);
                         addLog("Đã kết nối lại User Data Stream.");
                    } else {
                         addLog("Không thể lấy listenKey mới sau khi User Data WebSocket đóng. User Data Stream không khả dụng.");
                         // Bot sẽ tiếp tục chạy, nhưng PNL/xử lý trade sẽ trễ.
                    }
                } catch (e) {
                    addLog(`Thêm lỗi khi cố gắng lấy listenKey mới và kết nối lại User Data Stream: ${e.message}`);
                     // Nếu CriticalApiError, startBotLogicInternal sẽ xử lý retry bot.
                    if(e instanceof CriticalApiError) throw e; // Propagate error
                }
            }, 5000);
        } else {
             addLog("Bot dừng. Hủy kết nối lại User Data WebSocket.");
        }
    };
}


// --- HÀM CHÍNH CỦA BOT ---
/**
 * Chứa logic chính để mở lệnh mới (nếu không có vị thế mở).
 * Sẽ được gọi định kỳ bởi scheduleNextMainCycle.
 */
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot hiện không chạy, bỏ qua chu kỳ giao dịch.');
        return;
    }

    // Double check if there are already open positions on Binance API just in case local state is out of sync
     try {
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

        if (positionsOnBinance.length > 0 || currentLongPosition || currentShortPosition) {
            // Có vị thế mở trên sàn hoặc trong state local. Không mở lệnh mới.
            addLog(`Đã có vị thế mở cho ${TARGET_COIN_SYMBOL} (${positionsOnBinance.length} trên sàn, ${!!currentLongPosition} local LONG, ${!!currentShortPosition} local SHORT). Không mở lệnh mới.`);
            // Ensure local state reflects sàn if there was discrepancy.
             if (positionsOnBinance.length > 0) {
                 const longPosOnBinance = positionsOnBinance.find(p => p.positionSide === 'LONG');
                 const shortPosOnBinance = positionsOnBinance.find(p => p.positionSide === 'SHORT');
                 if (!currentLongPosition && longPosOnBinance) addLog('WARNING: Long position exists on Binance but not in bot state.');
                 if (!currentShortPosition && shortPosOnBinance) addLog('WARNING: Short position exists on Binance but not in bot state.');

                // If any position is found on Binance, ensure interval checker is running.
                 if (!positionCheckInterval && botRunning) {
                     addLog('Vị thế tồn tại. Khởi động lại interval kiểm tra.');
                     positionCheckInterval = setInterval(async () => { /* interval logic identical to startBotLogicInternal */
                         if (botRunning && (currentLongPosition || currentShortPosition)) { // Use local state for condition check in interval loop
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
                         } else if ((!currentLongPosition && !currentShortPosition) && positionCheckInterval){
                            // Dừng interval nếu không còn vị thế nào trong local state
                             addLog('Local state không có vị thế nào. Dừng interval kiểm tra.');
                             clearInterval(positionCheckInterval);
                             positionCheckInterval = null;
                             if(botRunning) scheduleNextMainCycle(); // Schedule new main cycle if bot still running
                        }
                     }, 5000);
                 }

             } else if (currentLongPosition || currentShortPosition) {
                 // This case shouldn't happen if sync works, but means local state might have old data while Binance has 0 positions
                 addLog('WARNING: Local state shows position(s) but Binance shows none. Forcing local state reset.');
                  currentLongPosition = null;
                  currentShortPosition = null;
                   // Proceed to opening new position in this case? Or let scheduleNextMainCycle decide after next check?
                   // Let scheduleNextMainCycle handle, it will check again.
             }

            return; // Return here as we should not open new positions
        }
        // If we reach here, there are 0 positions on Binance and in local state. Proceed to open new.


    } catch (error) {
         addLog(`Lỗi khi kiểm tra vị thế trên sàn trước khi mở lệnh mới: ${error.msg || error.message}`);
         // If CriticalApiError, startBotLogicInternal will handle retry.
         if(error instanceof CriticalApiError) throw error;
         // Non-critical errors, maybe a temporary network issue.
          addLog(`Đợi 5 giây trước khi thử lại runTradingLogic.`);
         await sleep(5000);
         if(botRunning) scheduleNextMainCycle(); // Retry the entire runTradingLogic logic via scheduler
         return;
    }


    addLog('Bắt đầu chu kỳ giao dịch mới: Mở cả hai lệnh LONG và SHORT...');

    try {
        // Fetch account again right before placing orders for most accurate balance
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`USDT khả dụng trước mở lệnh: ${usdtAsset.toFixed(2)}`);

        if (usdtAsset < (INITIAL_INVESTMENT_AMOUNT * 1.1 * 1)) { // Check initial total requirement + margin buffer
            addLog(`Số dư USDT quá thấp (${usdtAsset.toFixed(2)} USDT) để mở cả hai lệnh với vốn ban đầu ${INITIAL_INVESTMENT_AMOUNT} (yêu cầu tối thiểu ~${(INITIAL_INVESTMENT_AMOUNT * 1.1 * 2).toFixed(2)} USDT tính cả phí). Dừng mở lệnh. Đợi số dư đủ.`);
             // Wait and reschedule
            await sleep(5000);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
        if (!maxLeverage) {
            addLog(`Không thể lấy đòn bẩy cho ${TARGET_COIN_SYMBOL}. Hủy chu kỳ.`);
             // Wait and reschedule
             await sleep(5000);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        // Open LONG position first
        addLog(`Chuẩn bị mở lệnh LONG cho ${TARGET_COIN_SYMBOL} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT và đòn bẩy ${maxLeverage}x.`);
        const longPosAttempt = await openPosition(TARGET_COIN_SYMBOL, 'LONG', usdtAsset, maxLeverage); // Pass available balance

        if (!longPosAttempt) { // If LONG opening failed (and wasn't a CriticalApiError causing stopBotLogicInternal)
            addLog('Lỗi khi mở lệnh LONG. Hủy chu kỳ.');
            // Wait and reschedule. No need to clean Short as it wasn't opened yet.
             await sleep(5000);
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        currentLongPosition = longPosAttempt; // Update state if successful
        await sleep(2000); // Delay between orders


        // Fetch account again *before* opening SHORT to get current balance
         try {
             const accountAfterLong = await callSignedAPI('/fapi/v2/account', 'GET');
             usdtAsset = parseFloat(accountAfterLong.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
             addLog(`USDT khả dụng sau mở LONG: ${usdtAsset.toFixed(2)}`);
         } catch (balError) {
             addLog(`Lỗi lấy số dư sau mở LONG: ${balError.msg || balError.message}. Tiếp tục với số dư cũ hoặc ước tính.`);
             // In case of error fetching balance, continue using the pre-long balance as an estimate
         }


        // Open SHORT position
        addLog(`Chuẩn bị mở lệnh SHORT cho ${TARGET_COIN_SYMBOL} với vốn ${INITIAL_INVESTMENT_AMOUNT} USDT và đòn bẩy ${maxLeverage}x.`);
        const shortPosAttempt = await openPosition(TARGET_COIN_SYMBOL, 'SHORT', usdtAsset, maxLeverage); // Pass latest available balance or estimate

        if (!shortPosAttempt) { // If SHORT opening failed
            addLog('Lỗi khi mở lệnh SHORT. Đang cố gắng đóng lệnh LONG đã mở.');
            if (currentLongPosition) { // Check if LONG position object exists
                 // Use closePosition to ensure logic goes through User Data Stream
                 await closePosition(currentLongPosition.symbol, currentLongPosition.quantity, 'Lỗi mở lệnh SHORT', 'LONG');
                 // State for currentLongPosition will be reset to null by processTradeResult upon fill
            } else {
                 // Should not happen if currentLongPosition was assigned, but safety check
                addLog('Lệnh LONG đã được mở trước đó không còn trong bot state. Bỏ qua đóng.');
            }
            // Wait and reschedule
            await sleep(5000);
            if(botRunning) scheduleNextMainCycle();
            return; // Stop current runTradingLogic cycle
        }
         currentShortPosition = shortPosAttempt; // Update state if successful

        addLog(`Đã mở thành công cả hai lệnh LONG và SHORT cho ${TARGET_COIN_SYMBOL}.`);

        // Now that both positions are attempted, ensure the position check interval is running
        if (!positionCheckInterval && botRunning) {
             addLog('Đã mở cả hai lệnh. Khởi động interval kiểm tra vị thế.');
             positionCheckInterval = setInterval(async () => { /* interval logic identical to above */
                 if (botRunning && (currentLongPosition || currentShortPosition)) { // Use local state for condition check in interval loop
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
                 } else if ((!currentLongPosition && !currentShortPosition) && positionCheckInterval){
                    // Dừng interval nếu không còn vị thế nào trong local state
                     addLog('Local state không có vị thế nào. Dừng interval kiểm tra.');
                     clearInterval(positionCheckInterval);
                     positionCheckInterval = null;
                     if(botRunning) scheduleNextMainCycle(); // Schedule new main cycle if bot still running
                }
             }, 5000);
         }

        // After a delay, check and re-create missing initial TP/SL orders if needed
        setTimeout(async () => {
            if (botRunning) {
                addLog('Kiểm tra lại trạng thái lệnh TP/SL ban đầu sau 15 giây...');
                // Pass local position objects for checking
                if (currentLongPosition) {
                    await checkAndRecreateTPAndSL(currentLongPosition);
                }
                if (currentShortPosition) {
                    await checkAndRecreateTPAndSL(currentShortPosition);
                }
            }
        }, 15000); // 15 seconds delay

        // The cycle is now 'open'. The positionCheckInterval will manage it.
        // No need to call scheduleNextMainCycle here until the positions are closed.

    } catch (error) {
        addLog(`Lỗi trong chu kỳ giao dịch chính (runTradingLogic): ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng.`);
            stopBotLogicInternal();
            // stopBotLogicInternal will handle retry scheduling
        } else {
            // For non-critical errors during opening, wait 5 seconds and reschedule the cycle.
             addLog(`Đợi 5 giây trước khi lên lịch chu kỳ mới sau lỗi trong runTradingLogic.`);
            await sleep(5000);
            if(botRunning) scheduleNextMainCycle();
        }
    }
}


// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

/**
 * Khởi động toàn bộ logic của bot.
 * @returns {Promise<string>} Thông báo trạng thái khởi động.
 */
async function startBotLogicInternal() {
    if (botRunning) { // Nếu bot đã chạy rồi thì không làm gì
        addLog('Bot đang chạy.');
        return 'Bot đang chạy.';
    }

    // Đảm bảo API_KEY và SECRET_KEY được cấu hình
    if (!API_KEY || !SECRET_KEY) {
        const errorMsg = 'Lỗi: API Key hoặc Secret Key chưa được cấu hình. Vui lòng kiểm tra file config.js.';
        addLog(errorMsg);
         // Không ném CriticalApiError ở đây để tránh retry loop vô tận nếu config sai
         stopBotLogicInternal(); // Đảm bảo bot dừng clean nếu không có key
        return errorMsg;
    }

    // Hủy bỏ lịch tự động khởi động lại nếu có
    if (retryBotTimeout) {
        addLog('Hủy lịch tự động khởi động lại bot.');
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
    }

    addLog('--- Khởi động Bot ---');
    addLog('Kiểm tra kết nối API Binance Futures...');

    try {
        await syncServerTime(); // Đồng bộ thời gian

        // Lấy số dư USDT khả dụng trước khi kiểm tra vị thế
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtAsset).toFixed(2)}`);

        consecutiveApiErrors = 0; // Reset số lỗi API liên tiếp

        await getExchangeInfo(); // Tải thông tin sàn và cache
        if (!exchangeInfoCache || !exchangeInfoCache[TARGET_COIN_SYMBOL]) {
            const errorMsg = `Lỗi tải exchangeInfo hoặc không tìm thấy info cho ${TARGET_COIN_SYMBOL}. Bot dừng.`;
            addLog(errorMsg);
            // throw new CriticalApiError(errorMsg); // Ném lỗi để kích hoạt retry
             stopBotLogicInternal();
            return errorMsg;
        }

         // Kiểm tra và khôi phục vị thế đang mở trên sàn nếu có
        const positionsOnBinanceRaw = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);

        currentLongPosition = null; // Reset state trước khi khôi phục
        currentShortPosition = null;

        if (positionsOnBinance.length > 0) {
            addLog(`Tìm thấy ${positionsOnBinance.length} vị thế đang mở cho ${TARGET_COIN_SYMBOL}. Bot sẽ tiếp tục theo dõi các vị thế này.`);

            const maxLeverage = await getLeverageBracketForSymbol(TARGET_COIN_SYMBOL);
            if (!maxLeverage) {
                 const errorMsg = `Không thể lấy đòn bẩy khi khởi động lại để khôi phục vị thế. Dừng khởi động.`;
                 addLog(errorMsg);
                 // throw new CriticalApiError(errorMsg); // Ném lỗi để kích hoạt retry
                  stopBotLogicInternal();
                 return errorMsg;
            }

            // Thiết lập partialCloseLossLevels dựa trên đòn bẩy khi khởi động lại (sẽ giống lúc mở mới)
            let partialCloseLossSteps = [];
            if (maxLeverage >= 75) {
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 100);
            } else if (maxLeverage === 50) {
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 50);
            } else if (maxLeverage <= 25) {
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35);
            } else {
                for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 35); // Match the warning log in openPosition
            }

            // Get open orders once to restore TP/SL IDs
             const openOrdersOnBinance = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: TARGET_COIN_SYMBOL });

            for (const pos of positionsOnBinance) {
                const positionSide = pos.positionSide;
                 // Should find symbol info in cache at this point
                 const symbolInfo = exchangeInfoCache[TARGET_COIN_SYMBOL]; // Lấy từ cache

                 // Check if position is relevant based on current config (e.g. target symbol)
                 if (pos.symbol !== TARGET_COIN_SYMBOL) {
                      addLog(`Found position for irrelevant symbol ${pos.symbol}. Ignoring.`);
                     continue;
                 }


                const recoveredPosition = {
                    symbol: TARGET_COIN_SYMBOL,
                    quantity: Math.abs(parseFloat(pos.positionAmt)),
                    initialQuantity: Math.abs(parseFloat(pos.positionAmt)), // Khi khôi phục, initialQuantity = quantity hiện tại
                    entryPrice: parseFloat(pos.entryPrice),
                    initialTPPrice: 0, // Sẽ được cập nhật từ lệnh mở nếu tìm thấy
                    initialSLPrice: 0, // Sẽ được cập nhật từ lệnh mở nếu tìm thấy
                    initialMargin: INITIAL_INVESTMENT_AMOUNT, // Giả định initialMargin là vốn ban đầu được cấu hình. Có thể cần logic phức tạp hơn để khôi phục vốn ban đầu thực tế nếu vị thế mở ra từ chu kỳ trước đó.
                    openTime: new Date(parseFloat(pos.updateTime || Date.now())),
                    pricePrecision: symbolInfo ? symbolInfo.pricePrecision : 8, // Sử dụng precision từ cache
                    side: positionSide,
                    unrealizedPnl: parseFloat(pos.unRealizedProfit),
                    currentPrice: parseFloat(pos.markPrice),
                    currentTPId: null, // Sẽ khôi phục từ openOrders
                    currentSLId: null, // Sẽ khôi phục từ openOrders

                    // Reset các biến quản lý đóng một phần/điều chỉnh SL khi khởi động lại
                    closedAmount: 0, // Assume 0 partial closes at resume
                    partialCloseLossLevels: partialCloseLossSteps,
                    nextPartialCloseLossIndex: 0, // Assume no partial closes yet
                    closedQuantity: 0, // Assume 0 quantity closed
                    partialClosePrices: [], // Assume no partial close prices recorded
                    hasRemovedInitialSL: false, // Assume SL of winning leg is not yet removed at resume
                    hasAdjustedSL6thClose: false, // Assume no SL adjustments
                    hasAdjustedSL8thClose: false, // Assume no SL adjustments
                    maxLeverageUsed: maxLeverage, // Lưu đòn bẩy đã sử dụng
                };

                // Try to restore TP/SL Order IDs and Prices from open orders
                const relatedOrders = openOrdersOnBinance.filter(o => o.positionSide === positionSide && o.status === 'NEW' && o.symbol === TARGET_COIN_SYMBOL);
                 for (const order of relatedOrders) {
                    if (order.type === 'TAKE_PROFIT_MARKET') {
                         recoveredPosition.currentTPId = order.orderId;
                         recoveredPosition.initialTPPrice = parseFloat(order.stopPrice);
                         addLog(`Restored TP order ${order.orderId} (${parseFloat(order.stopPrice)}) for ${positionSide}.`);
                     } else if (order.type === 'STOP_MARKET') {
                         recoveredPosition.currentSLId = order.orderId;
                         recoveredPosition.initialSLPrice = parseFloat(order.stopPrice);
                         addLog(`Restored SL order ${order.orderId} (${parseFloat(order.stopPrice)}) for ${positionSide}.`);
                     }
                 }
                 // Special case: if recoveredPosition is LONG (potential winning leg) and maxLeverage >= 75,
                 // the initial SL is typically removed shortly after getting some profit.
                 // We can try to detect this condition based on whether an initial SL was found during recovery.
                if (recoveredPosition.side === 'LONG' && recoveredPosition.maxLeverageUsed >= 75 && !recoveredPosition.currentSLId) {
                     recoveredPosition.hasRemovedInitialSL = true;
                     addLog(`Detected potential winning LONG leg with high leverage, assuming initial SL was removed.`);
                 }


                if (positionSide === 'LONG') { // Only assign if the positionAmt matches the side expected
                     if(parseFloat(pos.positionAmt) > 0) currentLongPosition = recoveredPosition;
                     else addLog(`Ignoring LONG position with zero or negative amount ${pos.positionAmt}`);
                } else if (positionSide === 'SHORT') { // Only assign if the positionAmt matches the side expected
                    if(parseFloat(pos.positionAmt) < 0) currentShortPosition = recoveredPosition;
                     else addLog(`Ignoring SHORT position with zero or positive amount ${pos.positionAmt}`);
                }
            }

            // If after processing, both positions are still null, maybe positions existed but were closed *just now* or were for a different symbol
             if (!currentLongPosition && !currentShortPosition) {
                addLog(`Vị thế trên sàn đã đóng ngay trước khi khởi động. Sẽ bắt đầu chu kỳ mở lệnh mới.`);
                 // Will proceed to setup WS and schedule main cycle (which will call runTradingLogic to open new)
             } else {
                 addLog(`Đã khôi phục vị thế. Bot sẽ theo dõi và quản lý.`);
                 // Bot state now matches what was found on Binance (partially).
                 // Need to ensure TP/SL are properly in place, esp after resume.
                 // Let manageOpenPosition and checkAndRecreateTPAndSL handle verification/re-creation.
             }

        } else {
            addLog(`Không tìm thấy vị thế đang mở cho ${TARGET_COIN_SYMBOL} trên sàn.`);
            // State local positions should already be null, confirm.
            currentLongPosition = null;
            currentShortPosition = null;
        }


        // --- Start WebSocket connections ---
        listenKey = await getListenKey(); // Lấy listenKey cho User Data Stream
        if (listenKey) {
            setupUserDataStream(listenKey); // Thiết lập User Data Stream
        } else {
            addLog("Không thể khởi tạo User Data Stream. Bot sẽ tiếp tục nhưng cập nhật PNL/lệnh khớp có thể bị trễ.");
            // Do not throw CriticalApiError here. Bot can run without User Data Stream, just with less reactivity.
        }

        setupMarketDataStream(TARGET_COIN_SYMBOL); // Thiết lập Market Data Stream

        // --- Set bot state and schedule initial actions ---
        botRunning = true; // Đặt cờ bot đang chạy
        botStartTime = new Date(); // Ghi lại thời gian khởi động
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Đồng coin giao dịch: ${TARGET_COIN_SYMBOL}`);
        addLog(`Vốn ban đầu cho mỗi lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);

        // If positions were found and restored, schedule periodic management.
        // If no positions were found/restored, schedule the first trading cycle (runTradingLogic).
        // The scheduleNextMainCycle function already contains logic to check for existing positions
        // and either call runTradingLogic (if none) or implicitly let the positionCheckInterval manage (if positions exist).
        scheduleNextMainCycle(); // FIXED TYPO HERE! Was scheduleNextCycle()

        // Thiết lập kiểm tra vị thế định kỳ NẾU CHƯA CÓ (managed by scheduleNextMainCycle now)
        // Moved the interval setup logic into scheduleNextMainCycle itself for better flow.


        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('[Lỗi khởi động bot] ' + errorMsg);
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.');

        stopBotLogicInternal(); // Dừng bot nếu có lỗi khởi động
        // Lên lịch tự động khởi động lại nếu lỗi API nghiêm trọng CAUGHT BY startBotLogicInternal
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => {
                addLog('Thử khởi động lại bot...');
                await startBotLogicInternal(); // This recursive call handles the actual restart attempt
                retryBotTimeout = null; // Reset timeout ID after attempt
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

/**
 * Dừng toàn bộ logic của bot.
 * @returns {string} Thông báo trạng thái dừng.
 */
function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot không chạy.');
        return 'Bot không chạy.';
    }
    botRunning = false; // Đặt cờ bot dừng
    addLog('--- Đang dừng Bot ---');

    // Clear scheduled tasks
    clearTimeout(nextScheduledCycleTimeout); // Hủy chu kỳ tiếp theo
    if (positionCheckInterval) { // Hủy kiểm tra vị thế định kỳ
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }

    // Close all WebSocket connections
    addLog('Đang đóng kết nối WebSocket...');
    if (marketWs) {
        marketWs.close();
        marketWs = null;
        addLog('Market WebSocket đã đóng.');
    }
    if (userDataWs) {
        userDataWs.close();
        userDataWs = null;
        addLog('User Data WebSocket đã đóng.');
    }
    if (listenKeyRefreshInterval) { // Hủy làm mới listenKey
        clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = null;
        addLog('Đã hủy interval làm mới listenKey.');
    }
    listenKey = null; // Clear listenKey
    currentMarketPrice = null; // Clear cached price


    consecutiveApiErrors = 0; // Reset lỗi API

    // Important: Also cancel the automatic retry timeout if stopping manually
     if (retryBotTimeout) {
        addLog('Hủy lịch tự động khởi động lại bot do dừng thủ công.');
         clearTimeout(retryBotTimeout);
         retryBotTimeout = null;
     }


    addLog('--- Bot đã dừng ---');
    botStartTime = null; // Reset thời gian khởi động

    // Reset trạng thái vị thế và PNL khi dừng bot
    // WARNING: Resetting these *immediately* might cause issues if a final closePosition is pending confirmation from WS.
    // Maybe better to check status before resetting? For simplicity, resetting here.
    // The next startup logic will re-sync from Binance anyway.
    currentLongPosition = null;
    currentShortPosition = null;
    totalProfit = 0;
    totalLoss = 0;
    netPNL = 0;
     isClosingPosition = false; // Reset closing flag

    return 'Bot đã dừng.';
}

/**
 * Hàm kiểm tra và xử lý các vị thế còn sót lại trên sàn.
 * Được gọi khi bot khởi động hoặc sau khi một chu kỳ giao dịch hoàn tất.
 * @param {string} symbol - Cặp giao dịch.
 */
async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Đang kiểm tra vị thế còn sót lại cho ${symbol} sau khi một chu kỳ hoàn tất.`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPositions = positions.filter(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPositions.length > 0) {
            addLog(`Tìm thấy ${remainingPositions.length} vị thế còn sót lại cho ${symbol} trên sàn. Đang đóng...`);
            for (const pos of remainingPositions) {
                // Gọi closePosition với positionSide cụ thể để đóng
                const sideToClose = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
                addLog(`Force closing remaining ${sideToClose} position for ${pos.symbol} with amount ${pos.positionAmt}.`);
                await closePosition(pos.symbol, Math.abs(parseFloat(pos.positionAmt)), `Vị thế ${pos.symbol} còn sót lại (${pos.positionAmt}).`, sideToClose);
            }
            addLog(`Đã gửi lệnh đóng cho các vị thế còn sót lại. Chờ lệnh khớp...`);
             // Don't schedule next cycle immediately. Wait for the closing trades to report via WS.
             // The processTradeResult for the final closing orders will eventually call cleanupAndResetCycle.
             // If User Data stream is down, cleanupAndResetCycle might need a fail-safe.
             // For now, rely on the closing orders triggering the next step.
        } else {
            addLog(`Không có vị thế ${symbol} nào còn sót lại trên sàn.`);
            // Since no remaining positions found, we can proceed with cleanup and scheduling next cycle immediately.
             await cleanupAndResetCycle_Internal(symbol);
        }
    } catch (error) {
        addLog(`Lỗi khi kiểm tra và đóng vị thế sót lại cho ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) { // Dừng bot nếu lỗi API nghiêm trọng
             addLog(`Bot dừng do lỗi API nghiêm trọng khi xử lý vị thế sót.`);
             stopBotLogicInternal();
             // stopBotLogicInternal handles retry schedule
        } else {
             // Non-critical error getting position risk. Maybe try again after a delay?
             // The main manageOpenPosition loop should eventually correct state and handle it.
             addLog(`Ignoring non-critical error during remaining position check.`);
             await cleanupAndResetCycle_Internal(symbol); // Attempt cleanup and schedule anyway
        }
    }
}

/**
 * Hàm dọn dẹp và reset trạng thái bot sau khi một chu kỳ giao dịch kết thúc.
 * Được gọi sau khi TP/SL khớp VÀ lệnh đối ứng được đóng nốt (từ processTradeResult).
 * HOẶC khi checkAndHandleRemainingPosition xác nhận không còn vị thế sót.
 * @param {string} symbol - Cặp giao dịch.
 */
async function cleanupAndResetCycle_Internal(symbol) {
    addLog(`Đang tiến hành dọn dẹp và chuẩn bị cho chu kỳ giao dịch mới cho ${symbol}...`);

    // Hủy tất cả các lệnh chờ còn sót lại cho symbol (bao gồm TP/SL không khớp, limit/market orders nếu có)
    // IMPORTANT: Call this only after confirming all positions are closed on Binance!
    try {
        addLog(`Hủy tất cả lệnh chờ cho ${symbol}.`);
        await cancelOpenOrdersForSymbol(symbol, null, 'BOTH');
        addLog(`Đã hủy xong các lệnh chờ cho ${symbol}.`);
    } catch (error) {
        addLog(`Lỗi khi hủy lệnh chờ trong dọn dẹp: ${error.msg || error.message}`);
         // Non-critical error during cleanup cancel can be ignored.
    }

    // Reset local position state explicitly after checking Binance and cancelling orders
     currentLongPosition = null;
     currentShortPosition = null;

    // Stop the periodic position check interval if it's still running
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        addLog('Đã dừng interval kiểm tra vị thế định kỳ.');
    }

    // Nếu bot vẫn đang chạy, schedule chu kỳ mới (runTradingLogic)
    if (botRunning) {
        addLog(`Dọn dẹp hoàn tất. Bot đang chạy, lên lịch chu kỳ giao dịch mới.`);
        scheduleNextMainCycle(); // Schedule the function that checks state and calls runTradingLogic if needed
    } else {
         addLog(`Bot không chạy. Dọn dẹp hoàn tất nhưng không lên lịch chu kỳ mới.`);
         // stopBotLogicInternal already did its part.
    }
}


// --- KHỞI TẠO WEB SERVER VÀ CÁC API ENDPOINT ---
const app = express();
app.use(express.json()); // Sử dụng middleware để parse JSON body

// Endpoint để phục vụ file index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Endpoint để lấy logs của bot
app.get('/api/logs', (req, res) => {
    // Ưu tiên đọc từ CUSTOM_LOG_FILE, nếu không có/rỗng thì đọc từ BOT_LOG_FILE của PM2
    fs.readFile(CUSTOM_LOG_FILE, 'utf8', (err, customLogData) => {
        if (!err && customLogData && customLogData.trim().length > 0) {
            // Loại bỏ các ký tự màu sắc ANSI nếu có (do PM2 log) - LƯU Ý: LOGS CỦA addLog KHÔNG CÓ MÀU
            // Chỉ cần loại bỏ nếu đọc từ PM2 log
             //const cleanData = customLogData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
             const cleanData = customLogData; // Không cần regex cho custom log
            const lines = cleanData.split('\n');
            const maxDisplayLines = 500; // Giới hạn số dòng log hiển thị
            const startIndex = Math.max(0, lines.length - maxDisplayLines);
            const limitedLogs = lines.slice(startIndex).join('\n');
            res.send(limitedLogs);
        } else {
            // Nếu file tùy chỉnh không có hoặc rỗng, đọc từ log của PM2
            fs.readFile(BOT_LOG_FILE, 'utf8', (err, pm2LogData) => {
                if (err) {
                    console.error('Lỗi đọc log file:', err);
                    if (err.code === 'ENOENT') { // File not found
                        return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}. Đảm bảo PM2 đang chạy và tên log chính xác.`);
                    }
                    return res.status(500).send('Lỗi đọc log file');
                }
                // Loại bỏ các ký tự màu sắc ANSI nếu có (do PM2 log)
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


// Endpoint để lấy trạng thái bot (từ PM2 và trạng thái nội bộ)
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

        let statusMessage = 'MAY CHU: KHONG TIM THAY TIEN TRINH TRONG PM2';
        if (botProcess) {
             const pm2Status = botProcess.pm2_env.status.toUpperCase();
            statusMessage = `MAY CHU: ${pm2Status} (Restarts: ${botProcess.pm2_env.restart_time})`;

            // Get system uptime for PM2 process (optional but useful)
            if (botProcess.pm2_env.pm_uptime) {
                 const processUptime = Date.now() - botProcess.pm2_env.pm_uptime;
                 const processUptimeMinutes = Math.floor(processUptime / (1000 * 60));
                 statusMessage += ` | Uptime PM2: ${processUptimeMinutes} phút`;
             }


            // Add internal bot status only if PM2 process is online
            if (pm2Status === 'ONLINE') {
                statusMessage += ` | TRANG THAI BOT: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botRunning) {
                    if (botStartTime) {
                        const uptimeMs = Date.now() - botStartTime.getTime();
                        const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                        statusMessage += ` | Da Chay: ${uptimeMinutes} phút`;
                    } else {
                         statusMessage += ` | Da Chay: <Dang Cap Nhat>`;
                    }
                    statusMessage += ` | Coin: ${TARGET_COIN_SYMBOL}`;
                    statusMessage += ` | Von lenh: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                    statusMessage += ` | Connected WS: Market=${marketWs ? 'YES' : 'NO'}, User=${userDataWs ? 'YES' : 'NO'}`;
                     statusMessage += ` | Error count (API): ${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}`;

                } else { // Bot is stopped internally
                    statusMessage += ` | BOT KHONG CHAY`;
                    statusMessage += ` | Coin Configured: ${TARGET_COIN_SYMBOL}`;
                    statusMessage += ` | Von lenh Configured: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
                }

            } else {
                 // If PM2 status is not online, show configured values regardless of internal state
                  statusMessage += ` | Coin Configured: ${TARGET_COIN_SYMBOL}`;
                  statusMessage += ` | Von lenh Configured: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
            }


        } else {
            statusMessage = `Bot: Không tìm thấy tiến trình ${THIS_BOT_PM2_NAME} trong PM2. Đảm bảo đã chạy PM2!`;
            statusMessage += ` | Coin Configured: ${TARGET_COIN_SYMBOL}`;
            statusMessage += ` | Von lenh Configured: ${INITIAL_INVESTMENT_AMOUNT} USDT`;
        }


        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2 hoặc Bot nội bộ:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`);
    }
});


// Endpoint để lấy thống kê bot và vị thế đang mở
app.get('/api/bot_stats', async (req, res) => {
    try {
        // Fetch actual positions from Binance to be most accurate for display
         const positionsOnBinanceRaw = botRunning ? await callSignedAPI('/fapi/v2/positionRisk', 'GET') : [];
        const positionsOnBinance = positionsOnBinanceRaw.filter(p => p.symbol === TARGET_COIN_SYMBOL && parseFloat(p.positionAmt) !== 0);


        let openPositionsData = [];
        // Map from Binance positions to simplify for UI, using local state for other info
        if (currentLongPosition) { // Use local state as base, sync with Binance live data if available
             const longPosOnBinance = positionsOnBinance.find(p => p.positionSide === 'LONG');
            openPositionsData.push({
                symbol: currentLongPosition.symbol,
                side: currentLongPosition.side,
                quantity: longPosOnBinance ? Math.abs(parseFloat(longPosOnBinance.positionAmt)) : 0, // Use live qty
                initialQuantity: currentLongPosition.initialQuantity,
                entryPrice: longPosOnBinance ? parseFloat(longPosOnBinance.entryPrice) : currentLongPosition.entryPrice, // Use live entry price
                currentPrice: longPosOnBinance ? parseFloat(longPosOnBinance.markPrice) : currentMarketPrice || currentLongPosition.currentPrice || 0, // Use live mark price or cached/local
                unrealizedPnl: longPosOnBinance ? parseFloat(longPosOnBinance.unRealizedProfit) : currentLongPosition.unrealizedPnl || 0, // Use live PNL
                pricePrecision: currentLongPosition.pricePrecision,
                TPId: currentLongPosition.currentTPId, // From local state
                SLId: currentLongPosition.currentSLId, // From local state
                initialMargin: currentLongPosition.initialMargin,

                // Add properties for partial close/SL adjust logic from local state
                // Only relevant if the position object is still holding data (currentLongPosition != null)
                partialCloseLossLevels: currentLongPosition.partialCloseLossLevels, // From local
                nextPartialCloseLossIndex: currentLongPosition.nextPartialCloseLossIndex, // From local
                closedQuantity: currentLongPosition.closedQuantity, // From local
                partialClosePrices: currentLongPosition.partialClosePrices, // From local
                hasRemovedInitialSL: currentLongPosition.hasRemovedInitialSL, // From local
                hasAdjustedSL6thClose: currentLongPosition.hasAdjustedSL6thClose, // From local
                hasAdjustedSL8thClose: currentLongPosition.hasAdjustedSL8thClose, // From local
                 // Maybe add current profit percentage based on live PNL?
                 currentProfitPercentage: currentLongPosition.initialMargin > 0 ? ((longPosOnBinance ? parseFloat(longPosOnBinance.unRealizedProfit) : currentLongPosition.unrealizedPnl) / currentLongPosition.initialMargin) * 100 : 0

            });
        }
        if (currentShortPosition) { // Use local state as base, sync with Binance live data if available
             const shortPosOnBinance = positionsOnBinance.find(p => p.positionSide === 'SHORT');
            openPositionsData.push({
                symbol: currentShortPosition.symbol,
                side: currentShortPosition.side,
                quantity: shortPosOnBinance ? Math.abs(parseFloat(shortPosOnBinance.positionAmt)) : 0, // Use live qty
                initialQuantity: currentShortPosition.initialQuantity,
                 entryPrice: shortPosOnBinance ? parseFloat(shortPosOnBinance.entryPrice) : currentShortPosition.entryPrice, // Use live entry price
                currentPrice: shortPosOnBinance ? parseFloat(shortPosOnBinance.markPrice) : currentMarketPrice || currentShortPosition.currentPrice || 0, // Use live mark price or cached/local
                unrealizedPnl: shortPosOnBinance ? parseFloat(shortPosOnBinance.unRealizedProfit) : currentShortPosition.unrealizedPnl || 0, // Use live PNL
                pricePrecision: currentShortPosition.pricePrecision,
                TPId: currentShortPosition.currentTPId,
                SLId: currentShortPosition.currentSLId,
                initialMargin: currentShortPosition.initialMargin,

                // Add properties for partial close/SL adjust logic from local state
                partialCloseLossLevels: currentShortPosition.partialCloseLossLevels,
                nextPartialCloseLossIndex: currentShortPosition.nextPartialCloseLossIndex,
                closedQuantity: currentShortPosition.closedQuantity,
                partialClosePrices: currentShortPosition.partialClosePrices,
                 hasRemovedInitialSL: currentShortPosition.hasRemovedInitialSL,
                 hasAdjustedSL6thClose: currentShortPosition.hasAdjustedSL6thClose,
                 hasAdjustedSL8thClose: currentShortPosition.hasAdjustedSL8thClose,
                 currentProfitPercentage: currentShortPosition.initialMargin > 0 ? ((shortPosOnBinance ? parseFloat(shortPosOnBinance.unRealizedProfit) : currentShortPosition.unrealizedPnl) / currentShortPosition.initialMargin) * 100 : 0
            });
        }


        res.json({
            success: true,
            data: {
                totalProfit: totalProfit,
                totalLoss: totalLoss,
                netPNL: netPNL,
                currentOpenPositions: openPositionsData, // Send combined live/local data
                currentInvestmentAmount: INITIAL_INVESTMENT_AMOUNT, // From config
                 botRunning: botRunning // Include bot's internal running state
            }
        });
    } catch (error) {
        console.error('Lỗi khi lấy thống kê bot:', error);
        // Log CriticalApiError separately if it occurs here, maybe not stop the bot just for UI stats fetch fail?
         if (error instanceof CriticalApiError) {
              addLog(`Lỗi API nghiêm trọng khi lấy thống kê bot cho UI: ${error.msg || error.message}`);
         }
        res.status(500).json({ success: false, message: 'Lỗi khi lấy thống kê bot.', error: error.message || 'Unknown error' });
    }
});

// Endpoint để cấu hình bot (thay đổi coin, vốn)
app.post('/api/configure', (req, res) => {
    const { coinConfigs } = req.body;

    if (!coinConfigs || !Array.isArray(coinConfigs) || coinConfigs.length === 0 || !coinConfigs[0].symbol || !coinConfigs[0].initialAmount) {
         addLog("Lỗi cấu hình: Dữ liệu gửi lên không hợp lệ hoặc thiếu coinConfigs.");
        return res.status(400).json({ success: false, message: 'Dữ liệu cấu hình không hợp lệ.' });
    }


    // Không cho phép cấu hình lại khi bot đang chạy. Yêu cầu dừng bot trước.
     if (botRunning) {
         const msg = 'Vui lòng dừng bot trước khi cấu hình lại.';
         addLog(`Cảnh báo: Yêu cầu cấu hình bot khi đang chạy bị từ chối. ${msg}`);
        return res.status(409).json({ success: false, message: msg });
     }

    const config = coinConfigs[0];
    const oldTargetCoinSymbol = TARGET_COIN_SYMBOL;

     // Validate symbol format (uppercase)
     const newTargetCoinSymbol = config.symbol.trim().toUpperCase();
     if (!/^[A-Z]+USDT$/.test(newTargetCoinSymbol)) { // Simple validation for XXXUSDT format
        const msg = `Symbol ${newTargetCoinSymbol} không đúng định dạng (ví dụ: BTCUSDT).`;
        addLog(`Lỗi cấu hình: ${msg}`);
        return res.status(400).json({ success: false, message: msg });
     }


    const newInitialAmount = parseFloat(config.initialAmount);
     if (isNaN(newInitialAmount) || newInitialAmount <= 0) {
        const msg = `Số vốn ban đầu không hợp lệ: ${config.initialAmount}.`;
        addLog(`Lỗi cấu hình: ${msg}`);
        return res.status(400).json({ success: false, message: msg });
     }

     // Update config variables
    TARGET_COIN_SYMBOL = newTargetCoinSymbol;
    INITIAL_INVESTMENT_AMOUNT = newInitialAmount;


    // If symbol changed, reset internal state related to trading cycles
    // This reset should be done *after* checking bot is not running and config is valid.
    if (oldTargetCoinSymbol !== TARGET_COIN_SYMBOL) {
        addLog(`Đồng coin mục tiêu đã thay đổi từ ${oldTargetCoinSymbol} sang ${TARGET_COIN_SYMBOL}. Reset trạng thái giao dịch nội bộ.`);
        // Explicitly reset state. When bot starts again, it will sync from Binance.
        currentLongPosition = null;
        currentShortPosition = null;
        totalProfit = 0;
        totalLoss = 0;
        netPNL = 0;
        exchangeInfoCache = null; // Clear cache as it's symbol-dependent
         isClosingPosition = false; // Reset flag
        // WebSockets (Market and User Data) will be re-setup with new symbol/listenKey on next start.

    } else {
         addLog(`Cấu hình cập nhật cho đồng coin hiện tại ${TARGET_COIN_SYMBOL}.`);
    }

    addLog(`Đã cập nhật cấu hình thành công:`);
    addLog(`  Đồng coin: ${TARGET_COIN_SYMBOL}`);
    addLog(`  Số vốn ban đầu (mỗi lệnh): ${INITIAL_INVESTMENT_AMOUNT} USDT`);
    addLog('Khởi động lại bot để áp dụng cấu hình mới (nếu đang dừng).');


    res.json({ success: true, message: 'Cấu hình đã được cập nhật.' });
});

// Endpoint để khởi động bot
app.get('/start_bot_logic', async (req, res) => {
     let message = 'Đang chờ phản hồi từ bot logic...';
    try {
        message = await startBotLogicInternal();
         // Check internal state again just before sending response
         if(botRunning){
            res.json({success: true, message: message, botRunning: true});
         } else {
            res.json({success: false, message: message, botRunning: false});
         }
    } catch (error) {
        console.error('Lỗi khi gọi startBotLogicInternal:', error);
        // startBotLogicInternal should handle its own critical errors
        // But in case something unhandled happens:
        res.status(500).json({ success: false, message: `Lỗi khi khởi động bot: ${error.message || 'Unknown error'}`, botRunning: false });
    }
});

// Endpoint để dừng bot
app.get('/stop_bot_logic', (req, res) => {
     let message = 'Đang chờ phản hồi từ bot logic...';
    try {
        message = stopBotLogicInternal();
         res.json({ success: !botRunning, message: message, botRunning: botRunning });
    } catch (error) {
        console.error('Lỗi khi gọi stopBotLogicInternal:', error);
         res.status(500).json({ success: false, message: `Lỗi khi dừng bot: ${error.message || 'Unknown error'}`, botRunning: botRunning });
    }
});


// Khởi động Web Server
app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`);
    addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`);
});

// Optional: Auto-start bot logic when the process starts (if desired, currently manual via API/PM2)
// try {
//      addLog("Auto-starting bot logic...");
//      startBotLogicInternal().then(msg => addLog(`Auto-start result: ${msg}`));
// } catch (e) {
//      addLog(`Auto-start failed: ${e.message}`);
// }
