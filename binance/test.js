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
const WEB_SERVER_PORT = 1230; // Cổng cho Web Server
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
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`, true);
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
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors}/${MAX_CONSECUTIVE_API_ERRORS}). Dừng bot.`, true);
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
        }

        // Dọn dẹp trạng thái bot sau khi một chu kỳ giao dịch hoàn tất
        // Sẽ gọi cleanupAndResetCycle để hủy tất cả lệnh chờ và kiểm tra vị thế sót
        await cleanupAndResetCycle(symbol); 

        // manageOpenPosition sẽ tự động kích hoạt chu kỳ mới khi cả 2 vị thế là null
        // nên không cần scheduleNextMainCycle() ở đây nữa
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
            await sleep(1000); // Đợi lệnh khớp
        }

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol} (PositionSide: ${positionSide}): ${error.msg || error.message}`);
        // Xử lý lỗi -2011 nếu lệnh đã không tồn tại
        if (error.code === -2011) { 
            addLog(`Lỗi -2011 khi đóng vị thế ${symbol} (PositionSide: ${positionSide}), có thể vị thế đã đóng. Kiểm tra lại.`);
            await checkAndHandleRemainingPosition(symbol); // Thử kiểm tra và xử lý lại
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
        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}).`);
            return null;
        }

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
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 150); // 150%, 300%, ..., 1200%
        } else { // Trường hợp đòn bẩy khác các mốc trên (ví dụ: 30x, 40x...)
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc TP/SL/Partial Close. Sử dụng mặc định (TP 350%, SL 175%, Partial 150%).`);
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 1.75;
            for (let i = 1; i <= 8; i++) partialCloseLossSteps.push(i * 150); 
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
            initialSLPrice: slPrice, // Giá SL ban đầu
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
            nextPartialCloseLossIndex: 0, // Index của mốc đóng lệnh lỗ tiếp theo
            closedQuantity: 0, // Tổng số lượng (quantity) của lệnh lỗ đã đóng một phần
            partialClosePrices: [], // Lưu giá entry của lệnh lỗ tại thời điểm từng lần đóng một phần (dùng cho logic mở lại)

            // Cờ để quản lý trạng thái điều chỉnh SL
            hasRemovedInitialSL: false, // MỚI: Cờ hiệu đã hủy SL ban đầu của lệnh lãi
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
            addLog(`Đợi 2 giây trước khi lên lịch chu kỳ mới sau lỗi mở lệnh.`);
            return null; // Trả về null để runTradingLogic có thể xử lý lỗi và lên lịch lại
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
    if (position.initialQuantity === undefined || position.initialQuantity <= 0) {
        addLog(`Lỗi: Không có khối lượng ban đầu hợp lệ (initialQuantity) cho lệnh ${position.side} ${position.symbol}. Không thể đóng từng phần.`);
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

        const usdtAmountClosed = quantityToClose * currentPrice;

        if (type === 'PROFIT') { // Nếu là lệnh lãi được đóng một phần (theo yêu cầu thì không có logic này)
            position.closedAmount += usdtAmountClosed; 
        } else { // type === 'LOSS' (Lệnh lỗ được đóng một phần)
            position.closedQuantity += quantityToClose; // Tổng số lượng lệnh lỗ đã đóng một phần
            position.partialClosePrices.push(position.entryPrice); // Lưu giá entry của lệnh lỗ tại thời điểm đóng một phần
        }

        addLog(`Đã gửi lệnh đóng ${percentageOfInitialQuantity}% khối lượng ban đầu của lệnh ${position.side}.`);
        addLog(`Tổng lượng lệnh lỗ đã đóng một phần: ${position.closedQuantity.toFixed(quantityPrecision)}`);

        await sleep(1000); // Đợi lệnh khớp

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

        const orderSide = position.side === 'LONG' ? 'BUY' : 'SELL';

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: position.symbol,
            side: orderSide,
            positionSide: position.side, 
            type: 'MARKET',
            quantity: quantityToReopen,
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
            
            // Các cờ điều chỉnh SL được đặt ở `winningPos`, nên cần reset chúng thông qua winningPos.
            // Vì hàm addPosition được gọi trên `losingPos`, ta cần tìm `winningPos` để reset cờ của nó.
            let winningPosToResetFlags = (currentLongPosition && currentLongPosition.side !== position.side) ? currentLongPosition : currentShortPosition;
            if (winningPosToResetFlags) {
                winningPosToResetFlags.nextPartialCloseLossIndex = 0;
                winningPosToResetFlags.hasAdjustedSL6thClose = false;
                winningPosToResetFlags.hasAdjustedSL8thClose = false;
            }

            // Cập nhật lại TP và SL cho vị thế tổng cộng (cả 2 lệnh)
            addLog(`Đã cân bằng lại lệnh lỗ. Đang đặt lại TP/SL cho cả hai vị thế.`);
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
        if (maxLeverage >= 75) {
            TAKE_PROFIT_MULTIPLIER = 10; 
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; 
        } else if (maxLeverage === 50) {
            TAKE_PROFIT_MULTIPLIER = 5;  
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; 
        } else if (maxLeverage <= 25) { 
            TAKE_PROFIT_MULTIPLIER = 3.5; 
            STOP_LOSS_MULTIPLIER = TAKE_PROFIT_MULTIPLIER / 2; 
        } else {
            addLog(`Cảnh báo: maxLeverage ${maxLeverage} không khớp với các quy tắc SL. Sử dụng mặc định (TP 350%, SL 175%).`);
            TAKE_PROFIT_MULTIPLIER = 3.5;
            STOP_LOSS_MULTIPLIER = 1.75;
        }

        const profitTargetUSDT = INITIAL_INVESTMENT_AMOUNT * TAKE_PROFIT_MULTIPLIER; 
        const lossLimitUSDT = INITIAL_INVESTMENT_AMOUNT * STOP_LOSS_MULTIPLIER; 
        
        // Tính toán lại giá TP/SL dựa trên entryPrice MỚI và totalQuantity MỚI
        const priceChangeForTP = profitTargetUSDT / position.quantity;
        const priceChangeForSL = lossLimitUSDT / position.quantity;

        let newSLPrice, newTPPrice;
        const orderSideToClose = position.side === 'LONG' ? 'SELL' : 'BUY'; 

        if (position.side === 'LONG') {
            newSLPrice = position.entryPrice - priceChangeForSL;
            newTPPrice = position.entryPrice + priceChangeForTP;
            newSLPrice = Math.floor(newSLPrice / tickSize) * tickSize; 
            newTPPrice = Math.floor(newTPPrice / tickSize) * tickSize; 
        } else { // SHORT
            newSLPrice = position.entryPrice + priceChangeForSL;
            newTPPrice = position.entryPrice - priceChangeForTP; 
            newSLPrice = Math.ceil(newSLPrice / tickSize) * tickSize; 
            newTPPrice = Math.ceil(newTPPrice / tickSize) * tickSize; 
        }
        newSLPrice = parseFloat(newSLPrice.toFixed(pricePrecision));
        newTPPrice = parseFloat(newTPPrice.toFixed(pricePrecision));

        // Hủy TP/SL cũ và đặt lại
        await cancelOpenOrdersForSymbol(position.symbol, null, position.side);
        await sleep(500);

        // Đặt lệnh SL mới
        try {
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: orderSideToClose,
                positionSide: position.side, 
                type: 'STOP_MARKET',
                quantity: position.quantity,
                stopPrice: newSLPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            position.currentSLId = slOrderResult.orderId;
            position.initialSLPrice = newSLPrice; 
            addLog(`Đã đặt lại SL cho ${position.side} ${position.symbol} @ ${newSLPrice.toFixed(pricePrecision)}. OrderId: ${slOrderResult.orderId}`);
        } catch (slError) {
            addLog(`Lỗi đặt lại SL cho ${position.side} ${position.symbol}: ${slError.msg || slError.message}.`);
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
                await closePosition(position.symbol, position.quantity, `SL ${position.side} kích hoạt ngay sau mở thêm`, position.side);
                return;
            }
        }
        await sleep(500);

        // Đặt lệnh TP mới
        try {
            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: position.symbol,
                side: orderSideToClose,
                positionSide: position.side, 
                type: 'TAKE_PROFIT_MARKET',
                quantity: position.quantity,
                stopPrice: newTPPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            position.currentTPId = tpOrderResult.orderId;
            position.initialTPPrice = newTPPrice;
            addLog(`Đã đặt lại TP cho ${position.side} ${position.symbol} @ ${newTPPrice.toFixed(pricePrecision)}. OrderId: ${tpOrderResult.orderId}`);
        } catch (tpError) {
            addLog(`Lỗi đặt lại TP cho ${position.side} ${position.symbol}: ${tpError.msg || tpError.message}.`);
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${position.side} ${position.symbol}. Đóng vị thế.`);
                await closePosition(position.symbol, position.quantity, `TP ${position.side} kích hoạt ngay sau mở thêm`, position.side);
                return;
            }
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
    if (!position || !position.symbol) return;
    addLog(`Đang điều chỉnh SL cho lệnh ${position.side} ${position.symbol} về giá: ${targetSLPrice !== null ? targetSLPrice.toFixed(position.pricePrecision) : 'NULL'}.`);

    // Chỉ hủy lệnh SL hiện có của vị thế đó, đảm bảo hủy đúng positionSide
    if (position.currentSLId) {
        await cancelOpenOrdersForSymbol(position.symbol, position.currentSLId, position.side); 
        position.currentSLId = null;
        position.initialSLPrice = null; // Cập nhật trạng thái SL là null
        await sleep(500); 
    } else {
        addLog(`Không tìm thấy lệnh SL hiện có cho ${position.side} ${position.symbol} để hủy.`);
    }

    // Nếu targetSLPrice là null, chỉ hủy mà không đặt lại
    if (targetSLPrice === null) {
        addLog(`Đã hủy SL cho ${position.side} ${position.symbol}. Không đặt lại SL mới.`);
        return;
    }

    const symbolDetails = await getSymbolDetails(position.symbol);
    if (!symbolDetails) {
        addLog(`Lỗi lấy chi tiết symbol ${position.symbol}. Không thể điều chỉnh SL.`);
        return;
    }
    const { pricePrecision } = symbolDetails;

    try {
        const slOrderSide = position.side === 'LONG' ? 'SELL' : 'BUY'; 
        // Lấy số lượng thực tế của vị thế trên sàn để đặt lệnh SL mới
        const positionsOnBinance = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosOnBinance = positionsOnBinance.find(p => p.symbol === position.symbol && p.positionSide === position.side && parseFloat(p.positionAmt) !== 0);

        if (!currentPosOnBinance) {
            addLog(`Vị thế ${position.side} không còn tồn tại trên Binance để cập nhật SL. Bỏ qua.`);
            return;
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
}


/**
 * Hàm kiểm tra và quản lý vị thế đang mở. Đây là hàm chính chứa các logic phức tạp.
 * Chạy định kỳ để cập nhật trạng thái vị thế, đóng từng phần, điều chỉnh SL.
 */
const manageOpenPosition = async () => {
    // Nếu không còn vị thế nào hoặc interval đã được xóa (có thể do stopBotLogicInternal), dừng
    if (!currentLongPosition && !currentShortPosition && positionCheckInterval) {
        addLog('Không còn vị thế mở nào. Dừng kiểm tra định kỳ.');
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        if(botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ mới nếu bot vẫn chạy
        return;
    }

    if (isClosingPosition) { // Tránh xung đột nếu đang có lệnh đóng khác đang thực hiện
        addLog('Đang trong quá trình đóng vị thế, bỏ qua quản lý vị thế.'); 
        return;
    }

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        let hasActivePosition = false; // Cờ để kiểm tra xem còn vị thế nào hoạt động không

        // Cập nhật trạng thái cho Long Position từ Binance
        if (currentLongPosition) {
            const longPosOnBinance = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'LONG' && parseFloat(p.positionAmt) > 0);
            if (!longPosOnBinance || parseFloat(longPosOnBinance.positionAmt) === 0) {
                addLog(`Vị thế LONG ${TARGET_COIN_SYMBOL} đã đóng trên sàn. Cập nhật bot.`);
                currentLongPosition = null; // Reset vị thế trong bot
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
                hasActivePosition = true; // Có vị thế LONG đang hoạt động
            }
        }

        // Cập nhật trạng thái cho Short Position từ Binance
        if (currentShortPosition) {
            const shortPosOnBinance = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && p.positionSide === 'SHORT' && parseFloat(p.positionAmt) < 0);
            if (!shortPosOnBinance || parseFloat(shortPosOnBinance.positionAmt) === 0) {
                addLog(`Vị thế SHORT ${TARGET_COIN_SYMBOL} đã đóng trên sàn. Cập nhật bot.`);
                currentShortPosition = null; // Reset vị thế trong bot
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
                hasActivePosition = true; // Có vị thế SHORT đang hoạt động
            }
        }

        // Nếu không còn vị thế hoạt động nào sau khi cập nhật, dọn dẹp và lên lịch chu kỳ mới.
        if (!hasActivePosition) {
            addLog(`Đã xác nhận không còn vị thế mở nào cho ${TARGET_COIN_SYMBOL}.`);
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            if(botRunning) scheduleNextMainCycle();
            return; // Thoát khỏi hàm để không chạy logic tiếp theo nếu không có vị thế.
        }


        // --- Xác định lệnh lãi (winningPos) và lệnh lỗ (losingPos) ---
        let winningPos = null;
        let losingPos = null; 

        if (currentLongPosition && currentLongPosition.unrealizedPnl > 0) {
            winningPos = currentLongPosition;
            losingPos = currentShortPosition;
        } else if (currentShortPosition && currentShortPosition.unrealizedPnl > 0) {
            winningPos = currentShortPosition;
            losingPos = currentLongPosition;
        } else {
            // Trường hợp cả 2 lệnh đều lỗ hoặc hòa vốn
            addLog('Cả hai vị thế đều không có lãi hoặc đang lỗ. Bỏ qua logic đóng từng phần và điều chỉnh SL.');
            return; 
        }

        // Logic chỉ chạy nếu có lệnh lãi VÀ lệnh lỗ (đối ứng với lệnh lãi)
        if (winningPos && losingPos) {
            const currentProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
            
            // YÊU CẦU: Lệnh lãi chỉ có TP, không SL. -> Hủy SL ban đầu của lệnh lãi.
            if (winningPos.currentSLId && !winningPos.hasRemovedInitialSL) {
                addLog(`Lệnh ${winningPos.side} đang lãi. Hủy SL ban đầu của lệnh lãi.`);
                await updateStopLoss(winningPos, null); // Gọi updateStopLoss với null để hủy SL mà không đặt cái mới
                winningPos.currentSLId = null; // Cập nhật trạng thái
                winningPos.initialSLPrice = null; // Cập nhật trạng thái
                winningPos.hasRemovedInitialSL = true; // Đặt cờ hiệu đã hủy
            }

            // Logic đóng từng phần lệnh lỗ (dựa trên % lãi của lệnh lãi)
            const nextLossCloseLevel = winningPos.partialCloseLossLevels[winningPos.nextPartialCloseLossIndex];
            if (nextLossCloseLevel && currentProfitPercentage >= nextLossCloseLevel) {
                addLog(`Lệnh ${winningPos.side} đạt mốc lãi ${nextLossCloseLevel}%. Đang đóng 10% khối lượng ban đầu của lệnh ${losingPos.side} (lệnh lỗ).`);
                await closePartialPosition(losingPos, 10, 'LOSS'); // Đóng 10% khối lượng ban đầu của lệnh lỗ
                winningPos.nextPartialCloseLossIndex++; // Chuyển sang mốc đóng lỗ tiếp theo

                // YÊU CẦU: Khi 8 lần đóng 1 phần lệnh lỗ => đóng lệnh lỗ
                // Logic này sẽ được chạy ở đây, nhưng cũng cần đặt cờ để tránh chạy lại khi điều chỉnh SL sau đó.
                if (winningPos.nextPartialCloseLossIndex >= 8 && losingPos && Math.abs(losingPos.quantity) > 0) {
                    addLog(`Lệnh ${winningPos.side} đã đạt ${nextLossCloseLevel}%. Đã đóng 8 lần lệnh lỗ. Đang đóng toàn bộ lệnh lỗ ${losingPos.side}.`);
                    await closePosition(losingPos.symbol, losingPos.quantity, `Đóng toàn bộ lệnh lỗ khi lệnh lãi đạt ${nextLossCloseLevel}%`, losingPos.side);
                }
            }

            const symbolDetails = await getSymbolDetails(winningPos.symbol);
            const tickSize = symbolDetails ? symbolDetails.tickSize : 0.001;
            const pricePrecision = symbolDetails ? symbolDetails.pricePrecision : 8;

            // SL cho lệnh lỗ về hòa vốn (dựa trên entryPrice của chính lệnh lỗ)
            let slPriceForLosingPos_Breakeven = losingPos ? parseFloat(losingPos.entryPrice.toFixed(pricePrecision)) : null; 

            // Logic điều chỉnh SL khi đạt ngưỡng đóng một phần lệnh lỗ
            const partialCloseCount = winningPos.nextPartialCloseLossIndex; 
            
            // YÊU CẦU: Sau 6 lần đóng 1 phần lệnh lỗ. Rời sl cả 2 lệnh long short về giá lúc đóng 1 phần lệnh lỗ lần thứ 2
            if (partialCloseCount >= 6 && !winningPos.hasAdjustedSL6thClose) {
                // Đảm bảo có ít nhất 2 giá trong partialClosePrices (index 0 và 1)
                if (losingPos.partialClosePrices.length >= 2) {
                    const slTargetPrice = losingPos.partialClosePrices[1]; // Index 1 là lần đóng thứ 2 (0-indexed)
                    addLog(`Đạt mốc đóng lỗ lần ${partialCloseCount}. Điều chỉnh SL của cả 2 lệnh về giá đóng lỗ lần 2 (${slTargetPrice.toFixed(pricePrecision)}).`);
                    if (currentLongPosition) await updateStopLoss(currentLongPosition, slTargetPrice);
                    if (currentShortPosition) await updateStopLoss(currentShortPosition, slTargetPrice);
                    winningPos.hasAdjustedSL6thClose = true; 
                } else {
                    addLog(`Cảnh báo: Không đủ dữ liệu partialClosePrices (${losingPos.partialClosePrices.length} giá) để điều chỉnh SL lần 6 (chưa có giá đóng lỗ lần 2).`);
                }
            }
            
            // YÊU CẦU: Khi 8 lần đóng 1 phần lệnh lỗ => đóng lệnh lỗ và rời sl lệnh lãi về giá lần đóng 1 phần thứ 5
            // (Lệnh lỗ đã được đóng hoàn toàn ở logic trên, nên chỉ cần điều chỉnh SL lệnh lãi)
            if (partialCloseCount >= 8 && !winningPos.hasAdjustedSL8thClose) {
                // Đảm bảo có ít nhất 5 giá trong partialClosePrices (index 0 đến 4)
                if (losingPos.partialClosePrices.length >= 5) {
                    const slTargetPrice = losingPos.partialClosePrices[4]; // Index 4 là lần đóng thứ 5 (0-indexed)
                    addLog(`Đạt mốc đóng lỗ lần ${partialCloseCount}. Điều chỉnh SL của lệnh lãi ${winningPos.side} về giá đóng lỗ lần 5 (${slTargetPrice.toFixed(pricePrecision)}).`);
                    await updateStopLoss(winningPos, slTargetPrice);
                    winningPos.hasAdjustedSL8thClose = true; 
                } else {
                    addLog(`Cảnh báo: Không đủ dữ liệu partialClosePrices (${losingPos.partialClosePrices.length} giá) để điều chỉnh SL lệnh lãi lần 8 (chưa có giá đóng lỗ lần 5).`);
                }
            }
        }

        // Logic "khi lệnh lãi chạm từ mốc đóng 1 phần trở lên và lệnh lãi về 0% => mở thêm những phần đã đóng của lệnh lỗ"
        // Chỉ chạy khi có `winningPos` (lệnh lãi) và nó đã từng đóng một phần lệnh lỗ.
        if (winningPos && winningPos.partialCloseLossLevels && winningPos.nextPartialCloseLossIndex > 0) { 
             const currentWinningProfitPercentage = (winningPos.unrealizedPnl / winningPos.initialMargin) * 100;
             // Điều kiện: lãi của lệnh lãi về 0% (hoặc rất gần 0%) VÀ đã từng đóng một phần lệnh lỗ (từ 1 đến 7 lần)
             // Đảm bảo `losingPos` tồn tại và có `closedQuantity` (số lượng đã đóng một phần)
             if (currentWinningProfitPercentage <= 0.1 && losingPos && losingPos.closedQuantity > 0 && winningPos.nextPartialCloseLossIndex <= 7) { 
                    addLog(`Lệnh ${winningPos.side} đã đóng từng phần lỗ (tới lần ${winningPos.nextPartialCloseLossIndex}) và lãi trở về 0% (${currentWinningProfitPercentage.toFixed(2)}%). Đang mở thêm ${losingPos.closedQuantity.toFixed(losingPos.quantityPrecision)} khối lượng cho lệnh ${losingPos.side} để cân bằng.`);
                    await addPosition(losingPos, losingPos.closedQuantity, 'Cân bằng lại lệnh lỗ');
                    // Ghi chú: Việc reset trạng thái đóng một phần/SL adjustment đã được thực hiện trong hàm `addPosition`.
             }
        }
        
        // Logic "giá lệnh lãi trở về 0% => mở thêm số $ đã đóng" (cho lệnh lãi chính nó)
        // Theo yêu cầu của bạn, lệnh lãi không đóng từng phần, nên logic này sẽ không chạy.
        // Tôi giữ lại phần này với closedAmount = 0 để tránh lỗi, nhưng nó không tác dụng.
        // if (currentLongPosition && currentLongPosition.closedAmount > 0) { // closedAmount là của lệnh lãi
        //     const currentProfitPercentage = (currentLongPosition.unrealizedPnl / currentLongPosition.initialMargin) * 100;
        //     if (currentProfitPercentage <= 0.1) { 
        //         addLog(`Lệnh LONG đã đóng từng phần lãi và lãi trở về 0% (${currentProfitPercentage.toFixed(2)}%). Đang mở thêm số vốn đã đóng.`);
        //         await addPosition(currentLongPosition, currentLongPosition.closedAmount, 'PROFIT');
        //     }
        // }
        // if (currentShortPosition && currentShortPosition.closedAmount > 0) {
        //     const currentProfitPercentage = (currentShortPosition.unrealizedPnl / currentShortPosition.initialMargin) * 100;
        //     if (currentProfitPercentage <= 0.1) { 
        //         addLog(`Lệnh SHORT đã đóng từng phần lãi và lãi trở về 0% (${currentProfitPercentage.toFixed(2)}%). Đang mở thêm số vốn đã đóng.`);
        //         await addPosition(currentShortPosition, currentShortPosition.closedAmount, 'PROFIT');
        //     }
        // }

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

    if (currentLongPosition || currentShortPosition) {
        addLog('Có vị thế mở. Bỏ qua quét mới.');
        return;
    }

    clearTimeout(nextScheduledCycleTimeout);

    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 2 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000);
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
        return null;
    }
}

/**
 * Gửi yêu cầu làm mới listenKey để giữ kết nối User Data Stream hoạt động.
 */
async function keepAliveListenKey() {
    if (!listenKey) {
        addLog("Không có listenKey để làm mới.");
        return;
    }
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: listenKey });
    }
