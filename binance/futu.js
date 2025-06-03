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

// --- CẤU HÌNH API KEY VÀ SECRET KEY (NHẬP TRỰC TIẾP) ---
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc"; 

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


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH MỚI ---
const TARGET_SYMBOL = 'NEIROUSDT'; // Đồng coin mục tiêu
const TARGET_LEVERAGE = 75; // Đòn bẩy tối đa
const MIN_USDT_BALANCE_TO_OPEN = 0.01; // Số dư USDT tối thiểu để bot được phép mở lệnh

// Vốn ban đầu cho mỗi lệnh (USD)
const AMOUNT_USDT_PER_TRADE_INITIAL = 0.08; // 0.08 USD

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_INITIAL = 0.20; // 20% lợi nhuận trên vốn ban đầu
const STOP_LOSS_PERCENTAGE_INITIAL = 0.08; // 8% thua lỗ trên vốn ban đầu

// Cấu hình Martingale
const MARTINGALE_MAX_LEVEL = 5; // Số lần gấp lệnh tối đa
const MARTINGALE_MULTIPLIER = 2; // Hệ số gấp lệnh (ví dụ: x2 vốn)
const TAKE_PROFIT_PERCENTAGE_MARTINGALE = 0.05; // 5% lợi nhuận cộng thêm cho mỗi lệnh gấp

// Biến trạng thái Martingale
let martingaleLevel = 0; // Level Martingale hiện tại (0 = lệnh ban đầu)
let currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL; // Vốn cho lệnh hiện tại
let currentTradeSide = 'LONG'; // Hướng lệnh hiện tại ('LONG' hoặc 'SHORT')

// Lịch sử PNL của bot
let totalPnlUsdt = 0;
let totalInitialCapitalUsed = 0; // Tổng vốn đã dùng từ lúc bot chạy, để tính % PNL

// Hằng số cho thời gian chờ hủy lệnh sau khi đóng vị thế
const DELAY_BEFORE_CANCEL_ORDERS_MS = 6000; // 6 giây

// Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay
const RETRY_CHECK_POSITION_ATTEMPTS = 1; // 1 lần
const RETRY_CHECK_POSITION_DELAY_MS = 1000; // 1 giây

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 3333; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/futu-out.log';
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'futu';

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
            // Log lại nếu đã qua thời gian cooldown hoặc là tin quan trọng, và reset bộ đếm
            if (logCounts[messageHash].count > 1 && !isImportant) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            } else {
                console.log(logEntry); // Log lần đầu hoặc log tin quan trọng
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        // Nếu tin nhắn chưa có trong cache, log và thêm vào cache
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        console.log(logEntry);
    }

    // Áp dụng màu sắc cho log trong console
    // Không cần console.log lại ở đây vì đã log ở trên
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
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`;
                    }
                    addLog(`❌ HTTP Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`❌ Network lỗi: ${e.message}`);
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

    if (method === 'GET' || method === 'DELETE') { // GET và DELETE gửi params qua query string
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json'; // Hoặc không cần Content-Type cho GET/DELETE
    } else if (method === 'POST' || method === 'PUT') { // POST và PUT gửi params qua body
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0;
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`❌ Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -2015) {
            addLog("  -> Kiểm tra API Key/Secret và quyền Futures.");
        } else if (error.code === -1021) {
            addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính.");
        } else if (error.code === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số.");
        } else if (error.code === -1117) { // Cụ thể lỗi Invalid side
            addLog("  -> Lỗi 'Invalid side'. Đảm bảo tham số 'side' là 'BUY' hoặc 'SELL'.");
        }
        else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`⚠️ ${consecutiveApiErrors} lỗi API liên tiếp. Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
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
        addLog(`❌ Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`⚠️ ${consecutiveApiErrors} lỗi API liên tiếp. Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
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
        addLog(`✅ Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`, true);
    } catch (error) {
        addLog(`❌ Lỗi đồng bộ thời gian: ${error.message}.`, true);
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
                return parseInt(firstBracket.maxInitialLeverage || firstBracket.initialLeverage);
            }
        }
        addLog(`[DEBUG] Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    }
    catch (error) {
        addLog(`❌ Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Thiết lập đòn bẩy cho một symbol
async function setLeverage(symbol, leverage) {
    try {
        addLog(`[DEBUG] Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        });
        addLog(`✅ Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`);
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

    addLog('>>> Lấy exchangeInfo...', true);
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        addLog(`✅ Đã nhận exchangeInfo. Symbols: ${data.symbols.length}`, true);

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
        addLog('>>> Đã tải thông tin sàn.', true);
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
        addLog(`>>> Hủy lệnh mở cho ${symbol}...`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`✅ Đã hủy lệnh mở cho ${symbol}.`);
        return true;
    } catch (error) {
        // Lỗi -2011 "Unknown order sent." thường có nghĩa là không có lệnh nào để hủy
        if (error.code === -2011 && error.msg === 'Unknown order sent.') {
            addLog(`⚠️ Không có lệnh mở cho ${symbol}.`);
            return true;
        }
        addLog(`❌ Lỗi hủy lệnh mở cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return false;
    }
}

/**
 * Hàm làm tròn một giá trị đến số chữ số thập phân (`precision`) nhất định.
 * Có thể làm tròn lên (ceil), xuống (floor), hoặc làm tròn thông thường (round).
 * @param {number} value - Giá trị cần làm tròn.
 * @param {number} precision - Số chữ số thập phân mong muốn.
 * @param {'round'|'floor'|'ceil'} method - Phương pháp làm tròn.
 * @returns {number} Giá trị đã được làm tròn.
 */
function roundToPrecision(value, precision, method = 'round') {
    const factor = Math.pow(10, precision);
    let roundedValue;
    if (method === 'floor') {
        roundedValue = Math.floor(value * factor) / factor;
    } else if (method === 'ceil') {
        roundedValue = Math.ceil(value * factor) / factor;
    } else { // default to round
        roundedValue = Math.round(value * factor) / factor;
    }
    return parseFloat(roundedValue.toFixed(precision)); // toFixed để đảm bảo số chữ số thập phân
}


// Hàm đóng vị thế (Short hoặc Long)
async function closePosition(symbol, side, quantityToClose, reason = 'manual') {
    if (isClosingPosition) {
        addLog(`⚠️ Đang đóng lệnh. Bỏ qua yêu cầu mới cho ${symbol}.`);
        return;
    }
    isClosingPosition = true;

    const closeOrderSide = side === 'LONG' ? 'SELL' : 'BUY';
    addLog(`>>> Đóng lệnh ${side} ${symbol} (${reason}). Qty: ${quantityToClose}.`, true);
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`❌ Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`, true);
            isClosingPosition = false;
            // Nếu bot đang chạy, lên lịch chu kỳ mới ngay cả khi có lỗi lấy symbol info
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> ${symbol} đã đóng trên sàn hoặc không có vị thế. Lý do: ${reason}.`, true);
            
            // Xử lý PNL và Martingale ngay cả khi không có vị thế trên sàn
            // (trường hợp này xảy ra nếu lệnh đã khớp và bot chỉ vừa nhận ra)
            await processPnlAndMartingale(symbol); // Tách logic xử lý PNL ra hàm riêng

            currentOpenPosition = null; // Đảm bảo đã reset
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            stopCountdownFrontend();

            addLog(`>>> Đã đóng ${symbol}. Hủy lệnh chờ sau ${DELAY_BEFORE_CANCEL_ORDERS_MS / 1000}s.`);
            setTimeout(async () => {
                addLog(`>>> Hủy lệnh chờ cho ${symbol}.`);
                await cancelOpenOrdersForSymbol(symbol);
                await checkAndHandleRemainingPosition(symbol);
                if(botRunning) scheduleNextMainCycle(); // Quan trọng: lên lịch chu kỳ mới sau khi xử lý đóng lệnh
                isClosingPosition = false; // Reset cờ sau khi hoàn tất mọi thao tác
            }, DELAY_BEFORE_CANCEL_ORDERS_MS);
            return;
        }

        const actualPositionSide = parseFloat(currentPositionOnBinance.positionAmt) > 0 ? 'LONG' : 'SHORT';
        const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
        const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

        addLog(`[DEBUG] Gửi lệnh đóng ${actualPositionSide}: ${symbol}, ${closeOrderSide}, MARKET, Qty: ${adjustedActualQuantity}`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: closeOrderSide,
            type: 'MARKET',
            quantity: adjustedActualQuantity,
            reduceOnly: 'true'
        });

        addLog(`✅ Đã gửi lệnh đóng ${actualPositionSide} ${symbol}. Lý do: ${reason}.`, true);

        // Sau khi gửi lệnh, chờ một chút để lệnh được thực hiện
        await delay(1000); // Chờ 1 giây để lệnh thị trường khớp

        // Gọi manageOpenPosition để kiểm tra lại và cập nhật trạng thái
        // Nó sẽ tự động xóa currentOpenPosition nếu vị thế đã đóng và gọi scheduleNextMainCycle()
        await manageOpenPosition(); // manageOpenPosition sẽ xử lý reset isClosingPosition sau khi hoàn tất

    } catch (error) {
        addLog(`❌ Lỗi đóng ${side} ${symbol}: ${error.msg || error.message}`, true);
        isClosingPosition = false; // Đảm bảo cờ được reset ngay cả khi lỗi
        if(botRunning) scheduleNextMainCycle(); // Cố gắng lên lịch chu kỳ tiếp theo nếu bot vẫn chạy
    }
}

// Hàm kiểm tra và xử lý vị thế còn sót lại
async function checkAndHandleRemainingPosition(symbol, attempt = 1) {
    if (!botRunning) {
        addLog(`[DEBUG] Bot dừng, bỏ qua kiểm tra vị thế còn sót cho ${symbol}.`);
        return;
    }
    // Tăng số lần thử lại để đảm bảo vị thế được đóng hoàn toàn
    const MAX_RETRY_CHECK_POSITION_ATTEMPTS = 3; // Thử lại 3 lần
    if (attempt > MAX_RETRY_CHECK_POSITION_ATTEMPTS) {
        addLog(`⚠️ Đã thử ${MAX_RETRY_CHECK_POSITION_ATTEMPTS} lần cho ${symbol} nhưng vẫn còn vị thế. Vui lòng kiểm tra thủ công!`, true);
        return;
    }

    addLog(`>>> Kiểm tra vị thế còn sót cho ${symbol} (Lần ${attempt}/${MAX_RETRY_CHECK_POSITION_ATTEMPTS})...`);
    await delay(RETRY_CHECK_POSITION_DELAY_MS * attempt); // Delay tăng dần

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const currentPrice = await getCurrentPrice(symbol);
            if (!currentPrice) {
                addLog(`❌ Không lấy được giá hiện tại để xử lý vị thế sót của ${symbol}. Thử lại.`, true);
                await checkAndHandleRemainingPosition(symbol, attempt + 1);
                return;
            }
            const actualPositionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';

            addLog(`❌ Vị thế ${symbol} còn sót: ${currentPositionAmount} ${actualPositionSide} @ ${currentPrice}. Đang xử lý...`, true);

            // Cố gắng đóng vị thế sót một lần nữa
            // Sử dụng closePosition để đảm bảo logic đóng lệnh được thực thi đầy đủ
            await closePosition(symbol, actualPositionSide, Math.abs(currentPositionAmount), 'Vị thế sót');

        } else {
            addLog(`✅ Đã xác nhận không còn vị thế ${symbol}.`, true);
        }
    } catch (error) {
        addLog(`❌ Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`, true);
        // Nếu có lỗi API khi kiểm tra vị thế sót, vẫn thử lại theo số lần quy định
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
            currentCountdownMessage = `Vị thế ${currentOpenPosition.symbol}: Mở lệnh ${currentOpenPosition.side} | Level: ${martingaleLevel}`;
        } else {
            stopCountdownFrontend(); // Sẽ dừng interval nếu currentOpenPosition là null
        }
    }, 1000);
}

// Dừng bộ đếm ngược cho frontend
function stopCountdownFrontend() {
    if (countdownIntervalFrontend) {
        clearInterval(countdownIntervalFrontend);
        countdownIntervalFrontend = null;
    }
    const pnlPercentage = totalInitialCapitalUsed > 0 ? (totalPnlUsdt / totalInitialCapitalUsed * 100).toFixed(2) : '0.00';
    currentCountdownMessage = `Không có lệnh đang chờ đóng. PNL Tổng: ${totalPnlUsdt.toFixed(2)} USDT (${pnlPercentage}%)`;
}


/**
 * Hàm xử lý PNL và logic Martingale sau khi một vị thế đóng.
 * Được gọi khi bot phát hiện vị thế đã đóng trên sàn.
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function processPnlAndMartingale(symbol) {
    if (!currentOpenPosition) {
        addLog(`[DEBUG] Không có currentOpenPosition để xử lý PNL và Martingale cho ${symbol}.`);
        return;
    }

    addLog(`>>> Vị thế ${symbol} đã đóng trên sàn. Bắt đầu xử lý PNL và Martingale.`, true);

    // Fetch recent trades to calculate realized PnL
    const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { 
        symbol: symbol, 
        limit: 50, // Tăng giới hạn để đảm bảo lấy đủ các lệnh khớp
        startTime: currentOpenPosition.openTime.getTime() - (10 * 60 * 1000) // Tìm kiếm trong 10 phút gần nhất từ lúc mở lệnh
    }); 
    
    let pnlTrade = 0;
    let closeReason = "đã đóng trên sàn (không rõ lý do)";

    // Lọc các giao dịch khớp lệnh đóng vị thế
    // Một lệnh LONG được đóng bởi lệnh SELL, một lệnh SHORT được đóng bởi lệnh BUY
    const closingTrades = recentTrades.filter(t => 
        (currentOpenPosition.side === 'LONG' && t.side === 'SELL' && parseFloat(t.qty) > 0 && parseFloat(t.realizedPnl) !== 0) ||
        (currentOpenPosition.side === 'SHORT' && t.side === 'BUY' && parseFloat(t.qty) > 0 && parseFloat(t.realizedPnl) !== 0)
    ).sort((a, b) => new Date(b.time) - new Date(a.time)); // Sắp xếp giảm dần theo thời gian

    if (closingTrades.length > 0) {
        const totalRealizedPnlForPosition = closingTrades.reduce((sum, trade) => sum + parseFloat(trade.realizedPnl), 0);
        pnlTrade = totalRealizedPnlForPosition;

        if (pnlTrade > 0) {
            closeReason = "do TP khớp (lãi)";
        } else if (pnlTrade < 0) {
            closeReason = "do SL khớp (lỗ)";
        } else {
            closeReason = "đóng lệnh (hòa)"; // Có thể là hòa nếu PNL = 0
        }
    } else {
        // Nếu không tìm thấy trade có realizedPnl, đây có thể là lệnh đóng thủ công hoặc hòa
        // hoặc API chưa kịp cập nhật. Dùng PNL tạm tính nếu cần.
        addLog(`⚠️ Không tìm thấy giao dịch đóng vị thế với PNL thực tế cho ${symbol}.`, true);
        // Có thể bổ sung logic tính PNL dự kiến dựa trên giá đóng nếu cần
        // hoặc coi là hòa để Martingale reset.
        pnlTrade = 0; // Giả định là hòa hoặc không rõ PNL để Martingale reset
        closeReason = "đóng lệnh (không có PNL cụ thể)";
    }

    addLog(`>>> Vị thế ${symbol} ${closeReason}. Cập nhật bot.`, true);

    // Cập nhật PNL tổng
    totalPnlUsdt += pnlTrade;
    addLog(`  + PNL lệnh: ${pnlTrade.toFixed(2)} USDT. Tổng PNL: ${totalPnlUsdt.toFixed(2)} USDT.`);

    // Xử lý Martingale
    if (pnlTrade > 0) {
        addLog(`✅ Lệnh thành công! Reset Martingale level từ ${martingaleLevel} về 0.`, true);
        martingaleLevel = 0;
        currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
        currentTradeSide = 'LONG';
    } else {
        addLog(`❌ Lệnh thua lỗ. Tăng Martingale level từ ${martingaleLevel} lên ${martingaleLevel + 1}.`, true);
        martingaleLevel++;
        // Kiểm tra nếu đã vượt quá Martingale MAX LEVEL
        if (martingaleLevel > MARTINGALE_MAX_LEVEL) {
            addLog(`⚠️ Đạt giới hạn Martingale (${MARTINGALE_MAX_LEVEL} lần). Reset về level 0 và vốn ban đầu.`, true);
            martingaleLevel = 0;
            currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
            currentTradeSide = 'LONG';
        } else {
            currentTradeCapital *= MARTINGALE_MULTIPLIER;
            currentTradeSide = (currentTradeSide === 'LONG') ? 'SHORT' : 'LONG';
            addLog(`>>> Vốn cho lệnh tiếp theo: ${currentTradeCapital.toFixed(2)} USDT. Hướng: ${currentTradeSide}.`, true);
        }
    }
}

// Hàm mở lệnh
async function openPosition(symbol, side, capitalAmount, leverage) {
    if (currentOpenPosition) {
        addLog(`⚠️ Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`);
        if(botRunning) scheduleNextMainCycle();
        return;
    }
    if (isClosingPosition) {
        addLog(`⚠️ Đang trong quá trình đóng lệnh. Bỏ qua mở lệnh mới cho ${symbol}.`);
        if(botRunning) scheduleNextNextCycle(); // Gọi hàm lặp lại sau 5s thay vì ngay lập tức
        return;
    }

    addLog(`>>> Mở lệnh ${side} ${symbol}. Vốn: ${capitalAmount.toFixed(2)} USDT. Đòn bẩy: ${leverage}x.`, true);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`❌ Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const leverageSetSuccess = await setLeverage(symbol, leverage);
        if (!leverageSetSuccess) {
            addLog(`❌ Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}. Hủy mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        addLog(`[DEBUG] Giá ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // Tính toán số lượng
        let quantity = (capitalAmount * leverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty) {
            addLog(`⚠️ Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) cho ${symbol}. Hủy.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Qty cho ${symbol} là ${quantity}. Không hợp lệ. Hủy.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        // Kiểm tra số dư khả dụng một lần nữa trước khi đặt lệnh
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        // --- Bổ sung logic kiểm tra và reset vốn nếu số dư không đủ ---
        if (availableBalance < capitalAmount) {
            addLog(`⚠️ Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh ${side} với vốn ${capitalAmount.toFixed(2)}.`, true);
            // Reset Martingale về ban đầu và thử lại với vốn ban đầu
            martingaleLevel = 0;
            currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
            currentTradeSide = 'LONG'; // Quay lại hướng mặc định ban đầu
            addLog(`>>> Reset Martingale về level 0 và vốn ${currentTradeCapital.toFixed(2)} USDT.`, true);
            if(botRunning) scheduleNextMainCycle(); // Lên lịch chạy lại chu kỳ với vốn mới
            return;
        }
        // --- Kết thúc bổ sung logic ---

        // Khi mở lệnh MARKET, Binance mong đợi side là BUY hoặc SELL
        const orderSideForOpen = side === 'LONG' ? 'BUY' : 'SELL';

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSideForOpen,
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice);
        const openTime = new Date();
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`✅ Đã mở ${side} ${symbol} lúc ${formattedOpenTime}`, true);
        addLog(`  + Level: ${martingaleLevel} | Vốn: ${capitalAmount.toFixed(2)} USDT | Qty: ${quantity} ${symbol} | Giá vào: ${entryPrice.toFixed(pricePrecision)}`);

        totalInitialCapitalUsed += capitalAmount; // Cộng dồn vốn ban đầu đã sử dụng

        // Tính toán TP/SL mới
        let slPrice, tpPrice;
        let pnlForSl = capitalAmount * STOP_LOSS_PERCENTAGE_INITIAL;
        let pnlForTp;

        if (martingaleLevel === 0) { // Lệnh ban đầu
            pnlForTp = capitalAmount * TAKE_PROFIT_PERCENTAGE_INITIAL;
        } else { // Lệnh Martingale
            pnlForTp = capitalAmount * TAKE_PROFIT_PERCENTAGE_MARTINGALE;
        }

        if (side === 'LONG') {
            slPrice = entryPrice - (pnlForSl / (quantity * leverage));
            tpPrice = entryPrice + (pnlForTp / (quantity * leverage));
        } else { // SHORT
            slPrice = entryPrice + (pnlForSl / (quantity * leverage));
            tpPrice = entryPrice - (pnlForTp / (quantity * leverage));
        }

        // --- ĐIỂM ĐÃ SỬA LỖI PRECISION ---
        // Làm tròn SL/TP theo pricePrecision
        slPrice = roundToPrecision(slPrice, pricePrecision, side === 'LONG' ? 'floor' : 'ceil');
        tpPrice = roundToPrecision(tpPrice, pricePrecision, side === 'LONG' ? 'ceil' : 'floor');
        // --- KẾT THÚC ĐIỂM SỬA LỖI ---


        addLog(`>>> TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`, true);

        // Đặt lệnh SL
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: side === 'LONG' ? 'SELL' : 'BUY', // Khi đóng LONG thì là SELL, đóng SHORT thì là BUY
                type: 'STOP_MARKET',
                quantity: quantity,
                stopPrice: slPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            addLog(`✅ Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`, true);
        } catch (slError) {
            addLog(`❌ Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}.`, true);
            // Nếu SL bị lỗi ngay lập tức (ví dụ: giá đã qua SL), thì đóng vị thế ngay
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`⚠️ SL kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`, true);
                await closePosition(symbol, side, quantity, 'SL kích hoạt');
                return; // Quan trọng: dừng hàm nếu đã đóng vị thế
            }
        }

        // Đặt lệnh TP
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: side === 'LONG' ? 'SELL' : 'BUY', // Khi đóng LONG thì là SELL, đóng SHORT thì là BUY
                type: 'TAKE_PROFIT_MARKET',
                quantity: quantity,
                stopPrice: tpPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            addLog(`✅ Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`, true);
        } catch (tpError) {
            addLog(`❌ Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}.`, true);
            // Nếu TP bị lỗi ngay lập tức (ví dụ: giá đã qua TP), thì đóng vị thế ngay
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`⚠️ TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`, true);
                await closePosition(symbol, side, quantity, 'TP kích hoạt');
                return; // Quan trọng: dừng hàm nếu đã đóng vị thế
            }
        }

        currentOpenPosition = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            initialTPPrice: tpPrice,
            initialSLPrice: slPrice,
            initialMargin: capitalAmount,
            leverage: leverage,
            side: side,
            openTime: openTime,
            pricePrecision: pricePrecision,
        };

        // Bắt đầu kiểm tra vị thế định kỳ nếu chưa có
        if(!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if(botRunning) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`❌ Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`, true);
                        if(error instanceof CriticalApiError) {
                             addLog(`⚠️ Bot dừng do lỗi API trong quản lý vị thế.`, true);
                             stopBotLogicInternal();
                             if (!retryBotTimeout) { // Lên lịch tự động khởi động lại nếu chưa có
                                addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('>>> Thử khởi động lại bot...', true);
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, ERROR_RETRY_DELAY_MS);
                            }
                        }
                    }
                } else {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 300); // Tần suất kiểm tra vị thế
        }
        startCountdownFrontend(); // Bắt đầu cập nhật trạng thái trên frontend

    } catch (error) {
        addLog(`❌ Lỗi mở lệnh ${side} ${symbol}: ${error.msg || error.message}`, true);
        if(error instanceof CriticalApiError) {
            addLog(`⚠️ Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`, true);
            stopBotLogicInternal();
            if (!retryBotTimeout) { // Lên lịch tự động khởi động lại nếu chưa có
                addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
                retryBotTimeout = setTimeout(async () => {
                    addLog('>>> Thử khởi động lại bot...', true);
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else if(botRunning) {
            scheduleNextMainCycle(); // Nếu bot vẫn chạy, lên lịch cho lần quét tiếp theo
        }
    }
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP/Timeout)
 */
async function manageOpenPosition() {
    if (!botRunning) {
        // addLog('DEBUG: manageOpenPosition: Bot not running.', true); // Too verbose
        return;
    }

    // Nếu đang trong quá trình đóng lệnh, chờ cho đến khi hoàn tất
    if (isClosingPosition) {
        addLog('⚠️ Đang trong quá trình đóng lệnh. Bỏ qua kiểm tra vị thế mới cho NEIROUSDT.', true);
        return;
    }

    if (!currentOpenPosition) {
        // Nếu không có vị thế mở trong bot nhưng interval vẫn chạy, dừng nó.
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            addLog('DEBUG: Dừng interval kiểm tra vị thế vì currentOpenPosition là null.', true);
        }
        stopCountdownFrontend();
        if(botRunning) {
            // Khi không có vị thế mở, bot cần quay lại chu kỳ chính để tìm cơ hội
            scheduleNextMainCycle();
        }
        return;
    }

    const { symbol, quantity, side } = currentOpenPosition;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            // Vị thế đã đóng trên sàn, giờ tính PNL và xử lý Martingale
            await processPnlAndMartingale(symbol); // Gọi hàm xử lý PNL và Martingale

            // RESET TRẠNG THÁI BOT SAU KHI LỆNH ĐÓNG THÀNH CÔNG
            currentOpenPosition = null;
            // isClosingPosition được xử lý trong closePosition.
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            stopCountdownFrontend();

            addLog(`>>> Vị thế ${symbol} đã đóng. Hủy lệnh chờ sau ${DELAY_BEFORE_CANCEL_ORDERS_MS / 1000}s.`);
            setTimeout(async () => {
                addLog(`>>> Hủy lệnh chờ cho ${symbol}.`);
                await cancelOpenOrdersForSymbol(symbol);
                await checkAndHandleRemainingPosition(symbol);
                if(botRunning) scheduleNextMainCycle(); // Quan trọng: lên lịch chu kỳ mới sau khi xử lý đóng lệnh
            }, DELAY_BEFORE_CANCEL_ORDERS_MS);

            return;
        } else {
            // Vị thế vẫn còn mở trên sàn, kiểm tra giá để xác định TP/SL
            const currentPrice = await getCurrentPrice(symbol);
            if (!currentPrice) {
                 addLog(`⚠️ Không lấy được giá hiện tại cho ${symbol}. Bỏ qua kiểm tra TP/SL lần này.`);
                 return; // Nếu không lấy được giá, bỏ qua lần kiểm tra này
            }

            const isLong = currentOpenPosition.side === 'LONG';
            const slPrice = currentOpenPosition.initialSLPrice;
            const tpPrice = currentOpenPosition.initialTPPrice;

            const reachedSL = (isLong && currentPrice <= slPrice) || (!isLong && currentPrice >= slPrice);
            const reachedTP = (isLong && currentPrice >= tpPrice) || (!isLong && currentPrice <= tpPrice);

            // Kiểm tra và đóng vị thế nếu chạm SL/TP
            if (reachedSL) {
                addLog(`⚠️ Giá ${symbol} (${currentPrice.toFixed(currentOpenPosition.pricePrecision)}) chạm SL (${slPrice.toFixed(currentOpenPosition.pricePrecision)}). Đóng vị thế.`, true);
                await closePosition(symbol, side, quantity, 'Giá chạm SL');
            } else if (reachedTP) {
                addLog(`⚠️ Giá ${symbol} (${currentPrice.toFixed(currentOpenPosition.pricePrecision)}) chạm TP (${tpPrice.toFixed(currentOpenPosition.pricePrecision)}). Đóng vị thế.`, true);
                await closePosition(symbol, side, quantity, 'Giá chạm TP');
            } else {
                // Log trạng thái hiện tại nếu không có gì đặc biệt xảy ra, nhưng có cooldown
                addLog(`[DEBUG] ${symbol} đang mở: ${currentOpenPosition.side} @ ${currentOpenPosition.entryPrice.toFixed(currentOpenPosition.pricePrecision)}. Giá hiện tại: ${currentPrice.toFixed(currentOpenPosition.pricePrecision)}. TP: ${tpPrice.toFixed(currentOpenPosition.pricePrecision)}, SL: ${slPrice.toFixed(currentOpenPosition.pricePrecision)}`);
            }
        }

    } catch (error) {
        addLog(`❌ Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`, true);
        if(error instanceof CriticalApiError) {
             addLog(`⚠️ Bot dừng do lỗi API trong quản lý vị thế.`, true);
             stopBotLogicInternal();
             if (!retryBotTimeout) { // Lên lịch tự động khởi động lại nếu chưa có
                addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
                retryBotTimeout = setTimeout(async () => {
                    addLog('>>> Thử khởi động lại bot...', true);
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        }
    }
}

// Hàm chạy logic giao dịch (chỉ chạy khi không có vị thế mở)
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét.', true);
        return;
    }

    // Nếu có vị thế mở, chuyển sang quản lý vị thế hiện tại
    if (currentOpenPosition) {
        addLog('>>> Có vị thế mở. Bỏ qua quét mới và chờ vị thế đóng.', true);
        // Đảm bảo interval kiểm tra vị thế đang chạy
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`❌ Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`, true);
                        if(error instanceof CriticalApiError) {
                            addLog(`⚠️ Bot dừng do lỗi API trong kiểm tra vị thế.`, true);
                            stopBotLogicInternal();
                            if (!retryBotTimeout) {
                                addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
                                retryBotTimeout = setTimeout(async () => {
                                    addLog('>>> Thử khởi động lại bot...', true);
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
        return; // Quan trọng: Thoát khỏi hàm nếu đã có vị thế mở
    }

    addLog('>>> Bắt đầu chu kỳ giao dịch...', true);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT (${availableBalance.toFixed(2)}) dưới min (${MIN_USDT_BALANCE_TO_OPEN}). Tắt điện thoại đi uống bia đê`, true);
            scheduleNextMainCycle();
            return;
        }

        // Bổ sung logic kiểm tra và reset vốn nếu số dư không đủ TRƯỚC KHI cố gắng mở lệnh
        if (availableBalance < currentTradeCapital) {
            addLog(`⚠️ Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh ${currentTradeSide} với vốn ${currentTradeCapital.toFixed(2)}.`, true);
            martingaleLevel = 0;
            currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
            currentTradeSide = 'LONG'; // Quay lại hướng mặc định ban đầu
            addLog(`>>> Reset Martingale về level 0 và vốn ${currentTradeCapital.toFixed(2)} USDT.`, true);
            scheduleNextMainCycle(); // Lên lịch chạy lại chu kỳ với vốn mới
            return;
        }

        // Cố gắng mở lệnh mới
        await openPosition(TARGET_SYMBOL, currentTradeSide, currentTradeCapital, TARGET_LEVERAGE);

    } catch (error) {
        addLog('❌ Lỗi trong chu kỳ giao dịch: ' + (error.msg || error.message), true);
        if (error instanceof CriticalApiError) {
            addLog(`⚠️ Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
            stopBotLogicInternal();
            if (!retryBotTimeout) { // Lên lịch tự động khởi động lại nếu chưa có
                addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
                retryBotTimeout = setTimeout(async () => {
                    addLog('>>> Thử khởi động lại bot...', true);
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else {
            if(botRunning) scheduleNextMainCycle();
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot (chỉ chạy khi không có vị thế mở)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Không lên lịch chu kỳ mới.', true);
        clearTimeout(nextScheduledTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế mở. Chờ đóng vị thế hiện tại trước khi lên lịch lệnh mới.');
        // Nếu có vị thế mở, không lên lịch chu kỳ mới. ManageOpenPosition sẽ xử lý.
        return;
    }

    clearTimeout(nextScheduledTimeout);

    // Chu kỳ lặp lại cho việc chạy trading logic khi không có vị thế
    const delayBetweenCycles = 5000; // 5 giây (có thể điều chỉnh)

    addLog(`>>> Bot sẽ quét lại sau ${delayBetweenCycles / 1000}s để tìm cơ hội mở lệnh.`);

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) { // Kiểm tra lại botRunning trước khi chạy
            await runTradingLogic();
        } else {
            addLog('Bot dừng khi chờ. Không tiếp tục chu kỳ.', true);
        }
    }, delayBetweenCycles);
}


// Hàm lên lịch chu kỳ tiếp theo sau khi đang trong quá trình đóng lệnh
// (Chỉ gọi khi isClosingPosition = true để tránh vòng lặp)
async function scheduleNextNextCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Không lên lịch chu kỳ tiếp theo.', true);
        clearTimeout(nextScheduledTimeout);
        return;
    }

    clearTimeout(nextScheduledTimeout);

    const delayBetweenCycles = 5000; // 5 giây (có thể điều chỉnh)
    addLog(`>>> Bot sẽ quét lại sau ${delayBetweenCycles / 1000}s để tìm cơ hội mở lệnh.`);

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) { // Kiểm tra lại botRunning trước khi chạy
            await runTradingLogic();
        } else {
            addLog('Bot dừng khi chờ. Không tiếp tục chu kỳ.', true);
        }
    }, delayBetweenCycles);
}


// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đang chạy.', true);
        return 'Bot đang chạy.';
    }

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.', true);
    }

    addLog('--- Khởi động Bot ---', true);
    addLog('>>> Kiểm tra kết nối API Binance Futures...', true);

    try {
        await syncServerTime();

        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`, true);

        consecutiveApiErrors = 0; // Reset lỗi API khi khởi động thành công

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Lỗi tải exchangeInfo. Bot dừng.', true);
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        // --- Kiểm tra và khởi tạo trạng thái Martingale ---
        // Luôn kiểm tra vị thế trên sàn khi khởi động để đồng bộ trạng thái
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === TARGET_SYMBOL && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (currentPositionOnBinance) {
            addLog(`⚠️ Phát hiện vị thế ${TARGET_SYMBOL} đang mở trên sàn (${currentPositionOnBinance.positionAmt} ${parseFloat(currentPositionOnBinance.positionAmt) > 0 ? 'LONG' : 'SHORT'}). Bot sẽ cố gắng đóng vị thế này để bắt đầu lại.`);
            const existingSide = parseFloat(currentPositionOnBinance.positionAmt) > 0 ? 'LONG' : 'SHORT';
            const existingQuantity = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            // Đóng vị thế hiện có để đảm bảo bot bắt đầu từ trạng thái sạch
            // Khi đóng vị thế, nó sẽ tự động gọi processPnlAndMartingale và scheduleNextMainCycle()
            await closePosition(TARGET_SYMBOL, existingSide, existingQuantity, 'Khởi động bot');
            currentOpenPosition = null; // Đặt về null ngay sau khi gọi closePosition để tránh vòng lặp
        } else {
            addLog(`✅ Không có vị thế ${TARGET_SYMBOL} nào đang mở trên sàn. Bắt đầu từ lệnh mới.`);
            martingaleLevel = 0;
            currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL;
            currentTradeSide = 'LONG';
            currentOpenPosition = null; // Đảm bảo bot không nghĩ có vị thế mở khi bắt đầu
        }
        // --- Kết thúc kiểm tra Martingale ---


        botRunning = true;
        botStartTime = new Date();
        totalPnlUsdt = 0; // Reset PNL khi bot khởi động
        totalInitialCapitalUsed = 0; // Reset tổng vốn ban đầu khi bot khởi động

        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`, true);
        addLog(`  + Đồng coin: ${TARGET_SYMBOL}`);
        addLog(`  + Đòn bẩy: ${TARGET_LEVERAGE}x`);
        addLog(`  + Vốn vào lệnh ban đầu: ${AMOUNT_USDT_PER_TRADE_INITIAL} USDT`);

        // Gọi runTradingLogic ngay lập tức khi bot khởi động
        // nếu không có vị thế mở sau khi kiểm tra/đóng vị thế cũ.
        if (!currentOpenPosition) { // Đảm bảo không có vị thế mở trước khi gọi
            await runTradingLogic();
        } else {
            addLog(`>>> Đã có vị thế mở từ trước. Bot sẽ quản lý vị thế này.`, true);
            // Kích hoạt lại kiểm tra vị thế nếu có lệnh cũ
            if (!positionCheckInterval) {
                positionCheckInterval = setInterval(async () => {
                    if (botRunning && currentOpenPosition) {
                        try {
                            await manageOpenPosition();
                        } catch (error) {
                            addLog(`❌ Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`, true);
                            if(error instanceof CriticalApiError) {
                                addLog(`⚠️ Bot dừng do lỗi API trong kiểm tra vị thế.`, true);
                                stopBotLogicInternal();
                                if (!retryBotTimeout) {
                                    addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
                                    retryBotTimeout = setTimeout(async () => {
                                        addLog('>>> Thử khởi động lại bot...', true);
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
        }
        startCountdownFrontend(); // Bắt đầu cập nhật trạng thái frontend

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('❌ [Lỗi khởi động bot] ' + errorMsg, true);
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.', true);

        stopBotLogicInternal(); // Dừng bot nếu khởi động thất bại
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            addLog(`>>> Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`, true);
            retryBotTimeout = setTimeout(async () => {
                addLog('>>> Thử khởi động lại bot...', true);
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot không chạy.', true);
        return 'Bot không chạy.';
    }
    botRunning = false;
    clearTimeout(nextScheduledTimeout);
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    stopCountdownFrontend();
    consecutiveApiErrors = 0; // Reset lỗi API khi dừng bot
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.', true);
    }
    addLog('--- Bot đã dừng ---', true);
    botStartTime = null;
    currentOpenPosition = null; // Đảm bảo vị thế được reset khi bot dừng
    martingaleLevel = 0; // Reset martingale level khi bot dừng
    currentTradeCapital = AMOUNT_USDT_PER_TRADE_INITIAL; // Reset vốn khi bot dừng
    currentTradeSide = 'LONG';
    totalPnlUsdt = 0; // Reset PNL khi bot dừng
    totalInitialCapitalUsed = 0; // Reset tổng vốn khi bot dừng
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
            console.error('Lỗi đọc log file:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}. Đảm bảo đường dẫn chính xác và file tồn tại.`);
            }
            return res.status(500).send('Lỗi đọc log file');
        }
        // Xóa các ký tự màu sắc ANSI để hiển thị trên web tốt hơn
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
                statusMessage += ` | COIN: ${TARGET_SYMBOL}`;
                statusMessage += ` | PNL TONG: ${totalPnlUsdt.toFixed(2)} USDT`;
                if (totalInitialCapitalUsed > 0) {
                    statusMessage += ` (${(totalPnlUsdt / totalInitialCapitalUsed * 100).toFixed(2)}%)`;
                } else {
                    statusMessage += ` (0.00%)`;
                }
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`);
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
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`, true);
    addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`, true);
});
