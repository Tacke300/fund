import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Lấy __filename và __dirname trong ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH API KEY VÀ SECRET KEY ---
// !!! QUAN TRỌNG: DÁN API Key và Secret Key THẬT của bạn vào đây. !!!
// Đảm bảo không có khoảng trắng thừa khi copy/paste.
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); // THAY THẾ BẰNG API KEY THẬT CỦA BẠN
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // THAY THAY THẾ BẰNG SECRET KEY THẬT CỦA BẠN

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Offset thời gian để đồng bộ với server Binance

// Biến cache cho exchangeInfo để tránh gọi API lặp lại
let exchangeInfoCache = null;

// Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc
let isClosingPosition = false;

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// Biến để theo dõi vị thế đang mở
let currentOpenPosition = null; 
// Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
let positionCheckInterval = null; 
// Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (runTradingLogic)
let nextScheduledTimeout = null; 
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null; 

// Biến và interval cho việc hiển thị đếm ngược trên giao diện web
let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null; 

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0; // Đếm số lỗi API liên tiếp
const MAX_CONSECUTIVE_API_ERRORS = 5; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot
const ERROR_RETRY_DELAY_MS = 60000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 60 giây)

// Cache các thông điệp log để tránh spam quá nhiều dòng giống nhau liên tiếp
const logCounts = {}; // { messageHash: { count: number, lastLoggedTime: Date } }
const LOG_COOLDOWN_MS = 5000; // 5 giây cooldown cho các log không quan trọng lặp lại

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
// Số dư USDT tối thiểu trong ví futures để bot được phép mở lệnh
const MIN_USDT_BALANCE_TO_OPEN = 0.1; 

// SỐ PHẦN TRĂM CỦA TÀI KHOẢN USDT KHẢ DỤNG SẼ DÙNG CHO MỖI LỆNH ĐẦU TƯ BAN ĐẦU.
const PERCENT_ACCOUNT_PER_TRADE = 0.3; // Ví dụ: 0.01 = 1%

// Cấu hình Stop Loss:
// SL cố định X% của vốn đầu tư ban đầu (số tiền được tính từ PERCENT_ACCOUNT_PER_TRADE)
const STOP_LOSS_PERCENTAGE = 0.5; // 0.5 = 50% của vốn đầu tư ban đầu

// Bảng ánh xạ maxLeverage với Take Profit percentage.
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.15,  // 5% TP nếu đòn bẩy 20x
    25: 0.15,  // 6% TP nếu đòn bẩy 25x
    50: 0.18,  // 8% TP nếu đòn bẩy 50x
    75: 0.2,  // 10% TP nếu đòn bẩy 75x
    100: 0.25, // 12% TP nếu đòn bẩy 100x
    125: 0.33, // 15% TP nếu đòn bẩy 125x
};

// Ngưỡng funding rate âm tối thiểu để xem xét mở lệnh (ví dụ: -0.005 = -0.5%)
const MIN_FUNDING_RATE_THRESHOLD = -0.00001; 
// Thời gian tối đa giữ một vị thế (ví dụ: 180 giây = 3 phút)
const MAX_POSITION_LIFETIME_SECONDS = 180; 

// Cửa sổ thời gian (tính bằng phút) TRƯỚC giờ funding mà bot sẽ bắt đầu quét.
// Đặt là 1 phút để chỉ quét vào phút :59.
const FUNDING_WINDOW_MINUTES = 1; 

// Chỉ mở lệnh nếu thời gian còn lại đến funding <= X giây.
// Đặt là 60 để đảm bảo chỉ mở trong phút :59.
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 

// Thời gian (giây) TRƯỚC giờ funding chính xác mà bot sẽ cố gắng đặt lệnh.
// Đặt là 1 để cố gắng mở lệnh vào giây :59.
const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; 
// Thời gian (mili giây) LỆNH so với giây :59 để mở lệnh (để tránh quá tải).
// Đặt là 755ms để lệnh được gửi vào 59.755s.
const OPEN_TRADE_AFTER_SECOND_OFFSET_MS = 740; 

// Hằng số cho thời gian chờ hủy lệnh sau khi đóng vị thế
const DELAY_BEFORE_CANCEL_ORDERS_MS = 3.5 * 60 * 1000; // 3.5 phút = 210000 ms

// THAY ĐỔI MỚI: Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay
const RETRY_CHECK_POSITION_ATTEMPTS = 6; // 6 lần
const RETRY_CHECK_POSITION_DELAY_MS = 30000; // 30 giây

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 3000; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log';
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'bot_bina';

// --- HÀM TIỆN ÍCH ---

// === START - Cải tiến hàm addLog để tránh spam log giống nhau và tinh gọn log ===
function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        
        if (!isImportant && (now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return; 
        } else {
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }

    if (message.startsWith('✅')) {
        logEntry = `\x1b[32m${logEntry}\x1b[0m`; // Xanh lá
    } else if (message.startsWith('❌')) {
        logEntry = `\x1b[31m${logEntry}\x1b[0m`; // Đỏ
    } else if (message.startsWith('⚠️')) {
        logEntry = `\x1b[33m${logEntry}\x1b[0m`; // Vàng
    } else if (isImportant) {
        logEntry = `\x1b[36m${logEntry}\x1b[0m`; // Xanh dương (Cyan) cho tin quan trọng
    }

    console.log(logEntry);
}
// === END - Cải tiến hàm addLog ===

// Định dạng thời gian từ Date object sang string theo múi giờ UTC+7 (Asia/Ho_Chi_Minh)
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

// Hàm delay bất đồng bộ
const delay = ms => new Promise(resolve => setTimeout(() => resolve(), ms));

// Tạo chữ ký HMAC SHA256 cho các yêu cầu API
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

// Gửi HTTP request cơ bản
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
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`; // Tinh gọn log raw
                    }
                    addLog(`❌ HTTP Request lỗi: ${errorDetails.msg}`); // Tinh gọn log
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`❌ Network lỗi: ${e.message}`); // Tinh gọn log
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

// Gọi API Binance có chữ ký (dùng cho các thao tác tài khoản, lệnh)
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
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
    } else if (method === 'DELETE') { 
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json'; 
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`); // Tinh gọn log
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`❌ Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`); // Tinh gọn log
        if (error.code === -2015) {
            addLog("  -> Kiểm tra API Key/Secret và quyền Futures."); // Tinh gọn log
        } else if (error.code === -1021) {
            addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính."); // Tinh gọn log
        } else if (error.code === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số."); // Tinh gọn log
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai."); // Tinh gọn log
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng."); // Tinh gọn log
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`⚠️ ${consecutiveApiErrors} lỗi API liên tiếp. Dừng bot.`, true); // Tinh gọn log
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng."); // Tinh gọn log
        }
        throw error;
    }
}

// Gọi API Binance công khai (không cần chữ ký)
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
        addLog(`❌ Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`); // Tinh gọn log
        if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai."); // Tinh gọn log
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng."); // Tinh gọn log
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`⚠️ ${consecutiveApiErrors} lỗi API liên tiếp. Dừng bot.`, true); // Tinh gọn log
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng."); // Tinh gọn log
        }
        throw error;
    }
}

// Đồng bộ thời gian với server Binance để tránh lỗi timestamp
async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
        addLog(`✅ Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`, true); // Tinh gọn log
    } catch (error) {
        addLog(`❌ Lỗi đồng bộ thời gian: ${error.message}.`, true); // Tinh gọn log
        serverTimeOffset = 0;
        throw error;
    }
}

// Lấy thông tin đòn bẩy tối đa cho một symbol cụ thể
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });
        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);
            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                const firstBracket = symbolData.brackets[0];
                return parseInt(firstBracket.maxInitialLeverage || firstBracket.initialLeverage); // Tinh gọn
            }
        }
        addLog(`[DEBUG] Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`); // Tinh gọn log
        return null;
    } catch (error) {
        addLog(`❌ Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Thiết lập đòn bẩy cho một symbol
async function setLeverage(symbol, leverage) {
    try {
        addLog(`[DEBUG] Đặt đòn bẩy ${leverage}x cho ${symbol}.`); // Tinh gọn log
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        });
        addLog(`✅ Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`); // Tinh gọn log
        return true;
    } catch (error) {
        addLog(`❌ Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}

// Lấy thông tin sàn (exchangeInfo) và cache lại
async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    addLog('>>> Lấy exchangeInfo...', true); // Tinh gọn log
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        addLog(`✅ Đã nhận exchangeInfo. Symbols: ${data.symbols.length}`, true); // Tinh gọn log

        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
            };
        });
        addLog('>>> Đã tải thông tin sàn.', true); // Tinh gọn log
        return exchangeInfoCache;
    } catch (error) {
        addLog('❌ Lỗi lấy exchangeInfo: ' + (error.msg || error.message), true);
        exchangeInfoCache = null;
        throw error;
    }
}

// Hàm kết hợp để lấy tất cả filters và maxLeverage cho một symbol
async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        addLog(`[DEBUG] Không tìm thấy filters cho ${symbol}.`);
        return null;
    }
    const maxLeverage = await getLeverageBracketForSymbol(symbol);
    return { ...filters[symbol], maxLeverage: maxLeverage };
}

// Lấy giá hiện tại của một symbol
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        // Log lỗi này chỉ khi nó là lỗi nghiêm trọng để tránh spam
        if (error instanceof CriticalApiError) {
             addLog(`❌ Lỗi nghiêm trọng khi lấy giá cho ${symbol}: ${error.msg || error.message}`);
        }
        return null;
    }
}

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`>>> Hủy lệnh mở cho ${symbol}...`); // Tinh gọn log
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`✅ Đã hủy lệnh mở cho ${symbol}.`); // Tinh gọn log
        return true;
    } catch (error) {
        if (error.code === -2011 && error.msg === 'Unknown order sent.') {
            addLog(`⚠️ Không có lệnh mở cho ${symbol}.`); // Tinh gọn log
            return true;
        }
        addLog(`❌ Lỗi hủy lệnh mở cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return false;
    }
}

// Hàm đóng lệnh Short
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) {
        addLog(`⚠️ Đang đóng lệnh. Bỏ qua yêu cầu mới cho ${symbol}.`); // Tinh gọn log
        return; 
    }
    isClosingPosition = true;

    addLog(`>>> Đóng lệnh SHORT ${symbol} (SL:${reason}). Qty: ${quantityToClose}.`, true); // Tinh gọn log
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`❌ Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`); // Tinh gọn log
            isClosingPosition = false;
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) < 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> ${symbol} đã đóng trên sàn hoặc không có vị thế. Lý do: ${reason}.`, true); // Tinh gọn log
            currentOpenPosition = null;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval); 
                positionCheckInterval = null;
            }
            stopCountdownFrontend();
            
            addLog(`>>> Đã đóng ${symbol}. Hủy lệnh chờ sau ${DELAY_BEFORE_CANCEL_ORDERS_MS / 1000}s.`); // Tinh gọn log
            setTimeout(async () => {
                addLog(`>>> Hủy lệnh chờ cho ${symbol}.`); // Tinh gọn log
                await cancelOpenOrdersForSymbol(symbol);
                await checkAndHandleRemainingPosition(symbol); 
                if(botRunning) scheduleNextMainCycle();
                isClosingPosition = false;
            }, DELAY_BEFORE_CANCEL_ORDERS_MS);
            return;
        }
        
        const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
        const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

        addLog(`[DEBUG] Gửi lệnh đóng SHORT: ${symbol}, BUY, MARKET, Qty: ${adjustedActualQuantity}`); // Tinh gọn log

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: adjustedActualQuantity,
            reduceOnly: 'true'
        });

        addLog(`✅ Đã đóng SHORT ${symbol}. Lý do: ${reason}.`, true); // Tinh gọn log
        currentOpenPosition = null;
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
        }
        stopCountdownFrontend();
        
        addLog(`>>> Đã đóng ${symbol}. Hủy lệnh chờ sau ${DELAY_BEFORE_CANCEL_ORDERS_MS / 1000}s.`); // Tinh gọn log
        setTimeout(async () => {
            addLog(`>>> Hủy lệnh chờ cho ${symbol}.`); // Tinh gọn log
            await cancelOpenOrdersForSymbol(symbol);
            await checkAndHandleRemainingPosition(symbol);
            if(botRunning) scheduleNextMainCycle();
            isClosingPosition = false;
        }, DELAY_BEFORE_CANCEL_ORDERS_MS);

    } catch (error) {
        addLog(`❌ Lỗi đóng SHORT ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false;
    }
}

// Hàm kiểm tra và xử lý vị thế còn sót lại
async function checkAndHandleRemainingPosition(symbol, attempt = 1) {
    if (attempt > RETRY_CHECK_POSITION_ATTEMPTS) {
        addLog(`⚠️ Đã thử ${RETRY_CHECK_POSITION_ATTEMPTS} lần cho ${symbol} nhưng vẫn còn vị thế. Kiểm tra thủ công!`, true); // Tinh gọn log
        return;
    }

    addLog(`>>> Kiểm tra vị thế còn sót cho ${symbol} (Lần ${attempt}/${RETRY_CHECK_POSITION_ATTEMPTS})...`); // Tinh gọn log
    await delay(RETRY_CHECK_POSITION_DELAY_MS);

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const currentPrice = await getCurrentPrice(symbol);

            addLog(`❌ Vị thế ${symbol} còn sót: ${currentPositionAmount} @ ${currentPrice}. Đang xử lý...`, true); // Tinh gọn log

            if (currentOpenPosition) {
                addLog(`>>> Vị thế còn sót. Đặt lại TP/SL cho ${symbol}.`); // Tinh gọn log
                const { initialSLPrice, initialTPPrice } = currentOpenPosition;
                const symbolInfo = exchangeInfoCache[symbol];
                const quantityPrecision = symbolInfo.quantityPrecision;
                const pricePrecision = symbolInfo.pricePrecision;

                const actualQuantity = Math.abs(currentPositionAmount);
                const adjustedActualQuantity = parseFloat(actualQuantity.toFixed(quantityPrecision));

                try {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: symbol,
                        side: 'BUY', 
                        type: 'STOP_MARKET', 
                        quantity: adjustedActualQuantity, 
                        stopPrice: initialSLPrice, 
                        closePosition: 'true', 
                        newOrderRespType: 'FULL'
                    });
                    addLog(`✅ Đặt lại SL cho ${symbol} @ ${initialSLPrice.toFixed(pricePrecision)}.`, true); // Tinh gọn log
                } catch (slError) {
                    addLog(`❌ Lỗi đặt lại SL ${symbol}: ${slError.msg || slError.message}.`, true); // Tinh gọn log
                    if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                        addLog(`⚠️ SL kích hoạt cho ${symbol}. Đóng vị thế.`, true); // Tinh gọn log
                        await closeShortPosition(symbol, actualQuantity, 'SL kích hoạt (sót)');
                        return;
                    }
                }

                try {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: symbol,
                        side: 'BUY', 
                        type: 'TAKE_PROFIT_MARKET', 
                        quantity: adjustedActualQuantity, 
                        stopPrice: initialTPPrice, 
                        closePosition: 'true', 
                        newOrderRespType: 'FULL'
                    });
                    addLog(`✅ Đặt lại TP cho ${symbol} @ ${initialTPPrice.toFixed(pricePrecision)}.`, true); // Tinh gọn log
                } catch (tpError) {
                    addLog(`❌ Lỗi đặt lại TP ${symbol}: ${tpError.msg || tpError.message}.`, true); // Tinh gọn log
                    if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                        addLog(`⚠️ TP kích hoạt cho ${symbol}. Đóng vị thế.`, true); // Tinh gọn log
                        await closeShortPosition(symbol, actualQuantity, 'TP kích hoạt (sót)');
                        return;
                    }
                }

                const priceTooHighForShortSL = currentPositionAmount < 0 && currentPrice >= initialSLPrice;
                const priceTooLowForShortTP = currentPositionAmount < 0 && currentPrice <= initialTPPrice;

                if (priceTooHighForShortSL) {
                    addLog(`⚠️ Giá ${symbol} (${currentPrice}) > SL (${initialSLPrice}). Đóng vị thế.`, true); // Tinh gọn log
                    await closeShortPosition(symbol, actualQuantity, 'Giá vượt SL');
                    return;
                }
                if (priceTooLowForShortTP) {
                    addLog(`⚠️ Giá ${symbol} (${currentPrice}) < TP (${initialTPPrice}). Đóng vị thế.`, true); // Tinh gọn log
                    await closeShortPosition(symbol, actualQuantity, 'Giá vượt TP');
                    return;
                }
            } else {
                addLog(`⚠️ currentOpenPosition null nhưng vẫn còn vị thế sót cho ${symbol}. Đóng ngay lập tức.`, true); // Tinh gọn log
                await closeShortPosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót không rõ');
                return;
            }
            
            await checkAndHandleRemainingPosition(symbol, attempt + 1);

        } else {
            addLog(`✅ Đã xác nhận không còn vị thế ${symbol}.`, true); // Tinh gọn log
        }
    } catch (error) {
        addLog(`❌ Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`, true); // Tinh gọn log
        await checkAndHandleRemainingPosition(symbol, attempt + 1);
    }
}

// Bắt đầu bộ đếm ngược cho frontend
function startCountdownFrontend() {
    if (countdownIntervalFrontend) {
        clearInterval(countdownIntervalFrontend);
    }
    countdownIntervalFrontend = setInterval(() => {
        if (currentOpenPosition) {
            const currentTime = new Date();
            const elapsedTimeSeconds = (currentTime.getTime() - currentOpenPosition.openTime.getTime()) / 1000;
            const timeLeft = MAX_POSITION_LIFETIME_SECONDS - Math.floor(elapsedTimeSeconds);
            if (timeLeft >= 0) {
                currentCountdownMessage = `Vị thế ${currentOpenPosition.symbol}: Mở, còn ${timeLeft}s.`; // Tinh gọn log
            } else {
                currentCountdownMessage = `Vị thế ${currentOpenPosition.symbol}: Quá hạn. Đang đóng.`; // Tinh gọn log
            }
        } else {
            stopCountdownFrontend();
        }
    }, 1000);
}

// Dừng bộ đếm ngược cho frontend
function stopCountdownFrontend() {
    if (countdownIntervalFrontend) {
        clearInterval(countdownIntervalFrontend);
        countdownIntervalFrontend = null;
    }
    currentCountdownMessage = "Không có lệnh đang chờ đóng.";
}

// Hàm mở lệnh Short
async function openShortPosition(symbol, fundingRate, usdtBalance, maxLeverage) {
    if (currentOpenPosition) {
        addLog(`⚠️ Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`); // Tinh gọn log
        if(botRunning) scheduleNextMainCycle(); 
        return;
    }

    addLog(`>>> Mở SHORT ${symbol} (FR: ${fundingRate}).`, true); // Tinh gọn log
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`❌ Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`❌ Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        addLog(`[DEBUG] Giá ${symbol}: ${currentPrice.toFixed(pricePrecision)}`); // Tinh gọn log

        const initialMargin = usdtBalance * PERCENT_ACCOUNT_PER_TRADE; 

        if (usdtBalance < initialMargin) {
            addLog(`⚠️ Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${initialMargin.toFixed(2)}). Hủy.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        let quantity = (initialMargin * maxLeverage) / currentPrice; 
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty) {
            addLog(`⚠️ Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) cho ${symbol}. Hủy.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Qty cho ${symbol} là ${quantity}. Không hợp lệ. Hủy.`, true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' 
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice); 
        const openTime = new Date();
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`✅ Đã mở SHORT ${symbol} lúc ${formattedOpenTime}`, true);
        addLog(`  + FR: ${fundingRate} | Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Ký quỹ: ${initialMargin.toFixed(2)} USDT | Qty: ${quantity} ${symbol} | Giá vào: ${entryPrice.toFixed(pricePrecision)}`); // Tinh gọn log

        const slAmountUSDT = initialMargin * STOP_LOSS_PERCENTAGE; 
        const tpPercentage = TAKE_PROFIT_PERCENTAGES[maxLeverage]; 
        const tpAmountUSDT = initialMargin * tpPercentage; 

        let slPrice = entryPrice + (slAmountUSDT / quantity);
        let tpPrice = entryPrice - (tpAmountUSDT / quantity);

        slPrice = Math.ceil(slPrice / tickSize) * tickSize; 
        tpPrice = Math.floor(tpPrice / tickSize) * tickSize; 

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`>>> TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`, true); // Tinh gọn log

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: 'BUY', 
                type: 'STOP_MARKET', 
                quantity: quantity, 
                stopPrice: slPrice, 
                closePosition: 'true', 
                newOrderRespType: 'FULL'
            });
            addLog(`✅ Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`, true); // Tinh gọn log
        } catch (slError) {
            addLog(`❌ Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}.`, true); // Tinh gọn log
        }

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: 'BUY', 
                type: 'TAKE_PROFIT_MARKET', 
                quantity: quantity, 
                stopPrice: tpPrice, 
                closePosition: 'true', 
                newOrderRespType: 'FULL'
            });
            addLog(`✅ Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`, true); // Tinh gọn log
        } catch (tpError) {
            addLog(`❌ Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}.`, true); // Tinh gọn log
        }

        currentOpenPosition = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            initialTPPrice: tpPrice, 
            initialSLPrice: slPrice, 
            initialMargin: initialMargin, 
            openTime: openTime,
            pricePrecision: pricePrecision,
        };

        if(!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                if(botRunning) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`❌ Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`, true); // Tinh gọn log
                    }
                } else {
                    clearInterval(positionCheckInterval); 
                    positionCheckInterval = null;
                }
            }, 300);
        }
        startCountdownFrontend();

    } catch (error) {
        addLog(`❌ Lỗi mở SHORT ${symbol}: ${error.msg || error.message}`, true);
        if(error instanceof CriticalApiError) {
            addLog(`⚠️ Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`, true); // Tinh gọn log
        } else if(botRunning) {
            scheduleNextMainCycle(); 
        }
    }
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP/Timeout)
 */
async function manageOpenPosition() {
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) { 
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            stopCountdownFrontend(); 
            if(botRunning) scheduleNextMainCycle(); 
        }
        return;
    }

    const { symbol, quantity, openTime } = currentOpenPosition; 

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`⏱️ Vị thế ${symbol} quá hạn (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`, true); // Tinh gọn log
            await closeShortPosition(symbol, quantity, 'Hết thời gian');
            return; 
        }
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) < 0);
        
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, limit: 1 });
            let closeReason = "đã đóng trên sàn"; // Tinh gọn
            if (recentTrades.length > 0) {
                const latestTrade = recentTrades[0];
                if (latestTrade.buyer && parseFloat(latestTrade.qty) === Math.abs(parseFloat(currentOpenPosition.quantity))) {
                    if (latestTrade.price >= currentOpenPosition.initialSLPrice * 0.99 && latestTrade.price <= currentOpenPosition.initialSLPrice * 1.01) {
                        closeReason = "do SL khớp";
                    } else if (latestTrade.price <= currentOpenPosition.initialTPPrice * 1.01 && latestTrade.price >= currentOpenPosition.initialTPPrice * 0.99) {
                        closeReason = "do TP khớp";
                    } else if (latestTrade.price > currentOpenPosition.entryPrice) {
                         closeReason = "do SL khớp (giá tăng)";
                    } else if (latestTrade.price < currentOpenPosition.entryPrice) {
                         closeReason = "do TP khớp (giá giảm)";
                    }
                }
            }

            addLog(`>>> Vị thế ${symbol} ${closeReason}. Cập nhật bot.`, true); // Tinh gọn log
            currentOpenPosition = null;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            stopCountdownFrontend();
            
            addLog(`>>> Vị thế ${symbol} đã đóng. Hủy lệnh chờ sau ${DELAY_BEFORE_CANCEL_ORDERS_MS / 1000}s.`); // Tinh gọn log
            setTimeout(async () => {
                addLog(`>>> Hủy lệnh chờ cho ${symbol}.`); // Tinh gọn log
                await cancelOpenOrdersForSymbol(symbol);
                await checkAndHandleRemainingPosition(symbol); 
                if(botRunning) scheduleNextMainCycle();
            }, DELAY_BEFORE_CANCEL_ORDERS_MS);
            
            return;
        }

    } catch (error) {
        addLog(`❌ Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
             addLog(`⚠️ Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế.`, true); // Tinh gọn log
        }
    }
}

// Hàm chạy logic tìm kiếm cơ hội (chỉ chạy vào phút :59)
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét.', true); // Tinh gọn log
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế mở. Bỏ qua quét mới.', true); // Tinh gọn log
        return;
    }

    addLog('>>> Quét cơ hội mở lệnh (phút :59)...', true); // Tinh gọn log
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT (${availableBalance.toFixed(2)}) dưới min (${MIN_USDT_BALANCE_TO_OPEN}). Tắt điện thoại đi uống bia đê`, true); // Tinh gọn log
            scheduleNextMainCycle();
            return;
        }
        
        const estimatedCapitalToUse = availableBalance * PERCENT_ACCOUNT_PER_TRADE;

        if (availableBalance < estimatedCapitalToUse || estimatedCapitalToUse < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh với ${ (PERCENT_ACCOUNT_PER_TRADE*100).toFixed(2) }% (${estimatedCapitalToUse.toFixed(2)} USDT) hoặc quá nhỏ. Hủy.`, true); // Tinh gọn log
            scheduleNextMainCycle();
            return;
        }

        const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
        const now = Date.now();

        let eligibleCandidates = [];

        for (const item of allFundingData) {
            const fundingRate = parseFloat(item.lastFundingRate);
            const nextFundingTimeMs = item.nextFundingTime; 
            
            if (fundingRate < MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                const timeToFundingMinutes = (nextFundingTimeMs - now) / (1000 * 60);

                if (timeToFundingMinutes > 0 && timeToFundingMinutes <= FUNDING_WINDOW_MINUTES) {
                    const symbolDetails = await getSymbolDetails(item.symbol);
                    if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1 && TAKE_PROFIT_PERCENTAGES[symbolDetails.maxLeverage] !== undefined) {
                        const capitalToUseForEstimate = availableBalance * PERCENT_ACCOUNT_PER_TRADE;
                        const currentPrice = await getCurrentPrice(item.symbol);
                        if (currentPrice === null) {
                            addLog(`[DEBUG] Lỗi lấy giá cho ${item.symbol}. Bỏ qua.`); // Tinh gọn log
                            continue;
                        }
                        
                        let estimatedQuantity = (capitalToUseForEstimate * symbolDetails.maxLeverage) / currentPrice;
                        estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                        estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                        const currentNotional = estimatedQuantity * currentPrice;

                        if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                            eligibleCandidates.push({
                                symbol: item.symbol,
                                fundingRate: fundingRate,
                                nextFundingTime: nextFundingTimeMs,
                                maxLeverage: symbolDetails.maxLeverage
                            });
                        } else {
                            addLog(`[DEBUG] ${item.symbol}: FR âm, gần funding, nhưng KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh.`, false); // Tinh gọn log
                        }
                    } else {
                        addLog(`[DEBUG] ${item.symbol}: FR âm, gần funding, nhưng không có đòn bẩy/TP. Bỏ qua.`); // Tinh gọn log
                    }
                } else {
                    addLog(`[DEBUG] ${item.symbol}: FR âm, nhưng KHÔNG GẦN giờ funding. Bỏ qua.`); // Tinh gọn log
                }
            }
        }

        if (eligibleCandidates.length > 0) {
            eligibleCandidates.sort((a, b) => a.fundingRate - b.fundingRate);

            let selectedCandidateToOpen = null;

            for (const candidate of eligibleCandidates) {
                const nowRefreshed = Date.now();
                const targetOpenTimeMs = candidate.nextFundingTime - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
                const delayForExactOpenMs = targetOpenTimeMs - nowRefreshed;

                if (delayForExactOpenMs > 0 && delayForExactOpenMs <= (ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000)) {
                    selectedCandidateToOpen = candidate; 
                    break;
                } else {
                    addLog(`[DEBUG] Bỏ qua ${candidate.symbol}. Thời điểm mở lệnh không hợp lệ (còn ${Math.ceil(delayForExactOpenMs / 1000)}s).`, false); // Tinh gọn log
                }
            }

            if (selectedCandidateToOpen) { 
                const nowFinal = Date.now(); 
                const targetOpenTimeMs = selectedCandidateToOpen.nextFundingTime - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
                const delayForExactOpenMs = targetOpenTimeMs - nowFinal;

                if (delayForExactOpenMs <= 0) {
                    addLog(`⚠️ Quá thời điểm mở lệnh cho ${selectedCandidateToOpen.symbol}. Bỏ qua.`, true); // Tinh gọn log
                    if(botRunning) scheduleNextMainCycle();
                    return;
                }

                const capitalToUseForLog = availableBalance * PERCENT_ACCOUNT_PER_TRADE;
                const currentPrice = await getCurrentPrice(selectedCandidateToOpen.symbol);
                let estimatedQuantity = 0;
                if (currentPrice !== null && exchangeInfoCache[selectedCandidateToOpen.symbol]) {
                    const symbolInfo = exchangeInfoCache[selectedCandidateToOpen.symbol];
                    estimatedQuantity = (capitalToUseForLog * selectedCandidateToOpen.maxLeverage) / currentPrice;
                    estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                    estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
                }

                addLog(`\n✅ Chọn: ${selectedCandidateToOpen.symbol}`, true); // Tinh gọn log
                addLog(`  + FR: ${selectedCandidateToOpen.fundingRate} | Giờ Funding: ${formatTimeUTC7(new Date(selectedCandidateToOpen.nextFundingTime))}`); // Tinh gọn log
                addLog(`  + Đòn bẩy: ${selectedCandidateToOpen.maxLeverage}x | Vốn: ${capitalToUseForLog.toFixed(2)} USDT (Qty ước tính: ${estimatedQuantity})`); // Tinh gọn log
                addLog(`  + Mở lệnh sau ~${Math.ceil(delayForExactOpenMs / 1000)}s (${formatTimeUTC7(new Date(targetOpenTimeMs))}).`, true); // Tinh gọn log
                addLog(`>>> Đang chờ mở lệnh chính xác...`, true); // Tinh gọn log
                
                clearTimeout(nextScheduledTimeout);
                nextScheduledTimeout = setTimeout(async () => {
                    if (!currentOpenPosition && botRunning) {
                        await openShortPosition(selectedCandidateToOpen.symbol, selectedCandidateToOpen.fundingRate, availableBalance, selectedCandidateToOpen.maxLeverage);
                    } else if (!botRunning) {
                        addLog('Bot dừng khi chờ mở lệnh. Hủy.', true); // Tinh gọn log
                    } else {
                        addLog(`⚠️ Đã có vị thế mở trong khi chờ. Bỏ qua lệnh mới.`, true); // Tinh gọn log
                    }
                }, delayForExactOpenMs);
            } else { 
                addLog('>>> Không tìm thấy coin đủ điều kiện. Chờ chu kỳ quét tiếp theo (phút :59).', true); // Tinh gọn log
                if(botRunning) scheduleNextMainCycle();
            }

        } else { 
            addLog('>>> Không tìm thấy cơ hội mở lệnh. Chờ chu kỳ quét tiếp theo (phút :59).', true); // Tinh gọn log
            if(botRunning) scheduleNextMainCycle();
        }
    } catch (error) {
        addLog('❌ Lỗi trong tìm kiếm cơ hội: ' + (error.msg || error.message), true);
        if (error instanceof CriticalApiError) {
            addLog(`⚠️ Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true); // Tinh gọn log
            stopBotLogicInternal();
            retryBotTimeout = setTimeout(async () => {
                addLog('>>> Thử khởi động lại bot...', true); // Tinh gọn log
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        } else {
            if(botRunning) scheduleNextMainCycle(); 
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot (quét hoặc chờ đến phút :59)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Không lên lịch chu kỳ mới.', true); // Tinh gọn log
        clearTimeout(nextScheduledTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế mở. Chờ đóng vị thế hiện tại.', true); // Tinh gọn log
        return; 
    }

    clearTimeout(nextScheduledTimeout);

    const now = Date.now();
    const currentMinute = new Date(now).getUTCMinutes(); 
    let delayUntilNext59Minute;

    if (currentMinute < 59) {
        delayUntilNext59Minute = (59 - currentMinute) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    } else {
        delayUntilNext59Minute = (60 - currentMinute + 59) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    }

    if (delayUntilNext59Minute <= 0) {
        delayUntilNext59Minute = 1000;
    }

    const nextScanMoment = new Date(now + delayUntilNext59Minute);

    addLog(`>>> Bot sẽ quét lại lúc ${formatTimeUTC7(nextScanMoment)}.`); // Tinh gọn log

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) {
            await runTradingLogic();
        } else {
            addLog('Bot dừng khi chờ. Không tiếp tục chu kỳ.', true); // Tinh gọn log
        }
    }, delayUntilNext59Minute);
}

// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đang chạy.', true); // Tinh gọn log
        return 'Bot đang chạy.';
    }

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.', true); // Tinh gọn log
    }

    addLog('--- Khởi động Bot ---', true);
    addLog('>>> Kiểm tra kết nối API Binance Futures...', true); // Tinh gọn log

    try {
        await syncServerTime();

        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`, true); // Tinh gọn log
        
        consecutiveApiErrors = 0;

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Lỗi tải exchangeInfo. Bot dừng.', true); // Tinh gọn log
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`, true);

        scheduleNextMainCycle();

        if (!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) { 
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`❌ Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`, true); // Tinh gọn log
                        if(error instanceof CriticalApiError) {
                            addLog(`⚠️ Bot dừng do lỗi API trong kiểm tra vị thế.`, true); // Tinh gọn log
                            stopBotLogicInternal();
                            if (!retryBotTimeout) {
                                addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true); // Tinh gọn log
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('>>> Thử khởi động lại bot...', true); // Tinh gọn log
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
            }, 300);
        }
        startCountdownFrontend();

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('❌ [Lỗi khởi động bot] ' + errorMsg, true); // Tinh gọn log
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.', true); // Tinh gọn log
       
        stopBotLogicInternal();
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true); // Tinh gọn log
            retryBotTimeout = setTimeout(async () => {
                addLog('>>> Thử khởi động lại bot...', true); // Tinh gọn log
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot không chạy.', true); // Tinh gọn log
        return 'Bot không chạy.';
    }
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    stopCountdownFrontend();
    consecutiveApiErrors = 0;
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.', true); // Tinh gọn log
    }
    addLog('--- Bot đã dừng ---', true);
    botStartTime = null;
    return 'Bot đã dừng.';
}

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi đọc log file:', err); // Tinh gọn log
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}.`); // Tinh gọn log
            }
            return res.status(500).send('Lỗi đọc log file'); // Tinh gọn log
        }
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        
        const lines = cleanData.split('\n');
        const maxDisplayLines = 500;
        const startIndex = Math.max(0, lines.length - maxDisplayLines);
        const limitedLogs = lines.slice(startIndex).join('\n');

        res.send(limitedLogs);
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
                statusMessage += ` | TRANG THAI: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                }
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`; // Tinh gọn log
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error); // Tinh gọn log
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`); // Tinh gọn log
    }
});

app.get('/api/countdown', (req, res) => {
    res.send(currentCountdownMessage);
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
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`, true); // Tinh gọn log
    addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`, true); // Tinh gọn log
});
