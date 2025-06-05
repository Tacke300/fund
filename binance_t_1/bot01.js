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

// --- CẤU HÌNH API KEY VÀ SECRET KEY (BAN ĐẦU RỖNG) ---
let API_KEY = '';
let SECRET_KEY = '';

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
let nextScheduledCycleTimeout = null;
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null;

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0; // Đếm số lỗi API liên tiếp
const MAX_CONSECUTIVE_API_ERRORS = 5; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot
const ERROR_RETRY_DELAY_MS = 5000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 5 giây)

// Cache các thông điệp log để tránh spam quá nhiều dòng giống nhau liên tiếp
const logCounts = {}; // { messageHash: { count: number, lastLoggedTime: Date } }
const LOG_COOLDOWN_MS = 1000; // 1 giây cooldown cho các log không quan trọng lặp lại

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH (GIÁ TRỊ MẶC ĐỊNH) ---
let INITIAL_INVESTMENT_AMOUNT = 10; // Mặc định 10 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'BTCUSDT'; // Mặc định BTCUSDT (sẽ được cập nhật từ UI)
let APPLY_DOUBLE_STRATEGY = false; // Mặc định false (sẽ được cập nhật từ UI)

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.30; // 60% lãi trên VỐN
const STOP_LOSS_PERCENTAGE_MAIN = 0.175;   // 17.5% lỗ trên VỐN

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

// Biến theo dõi vốn hiện tại cho lệnh
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
// Biến theo dõi số lần lỗ liên tiếp
let consecutiveLossCount = 0;
// Biến theo dõi hướng lệnh tiếp theo (SHORT là mặc định ban đầu)
let nextTradeDirection = 'SHORT';

// Biến theo dõi PNL tổng
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;


// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1234; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log'; // Cần điều chỉnh nếu dùng PM2
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'tung01'; // Cần điều chỉnh nếu dùng PM2

// --- HÀM TIỆN ÍCH ---

// === START - Cải tiến hàm addLog để tránh spam log giống nhau và tinh gọn log ===
function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            logCounts[messageHash].count++; // Tăng số đếm nhưng không log ra
            return;
        } else {
            // Nếu đã qua cooldown và có log lặp lại, in ra số lần lặp
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${logCounts[messageHash].originalMessage}`);
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now, originalMessage: message };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: now, originalMessage: message };
    }
    console.log(logEntry); // Ghi ra console của server
    // Gửi log qua WebSocket nếu có (chưa triển khai WebSocket ở đây, chỉ là ví dụ)
    // ws.send(logEntry);
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

// Gọi API Binance có chữ ký (dùng cho các thao tác tài khoản, lệnh)
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new CriticalApiError("API Key hoặc Secret Key chưa được cấu hình.");
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
        } else if (error.code === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số.");
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp. Dừng bot.`, true);
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
        addLog(`Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp. Dừng bot.`, true);
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
        addLog(`Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`);
    } catch (error) {
        addLog(`Lỗi đồng bộ thời gian: ${error.message}.`);
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
        addLog(`Không tìm thấy đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Thiết lập đòn bẩy cho một symbol
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
        return false;
    }
}

// Lấy thông tin sàn (exchangeInfo) và cache lại
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

// Hàm kết hợp để lấy tất cả filters và maxLeverage cho một symbol
async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        addLog(`Không tìm thấy filters cho ${symbol}.`);
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
            addLog(`Lỗi nghiêm trọng khi lấy giá cho ${symbol}: ${error.msg || error.message}`);
        }
        return null;
    }
}

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`Hủy tất cả lệnh mở cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`Đã hủy tất cả lệnh mở cho ${symbol}.`);
        return true;
    } catch (error) {
        // Lỗi 20002 có thể là "No orders exist" hoặc "Orders not found"
        if (error.code === -20002 || (error.msg && error.msg.includes("No orders exist"))) {
            addLog(`Không có lệnh mở nào để hủy cho ${symbol}.`);
            return true;
        }
        addLog(`Lỗi khi hủy lệnh mở cho ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}

/**
 * Hàm cập nhật PNL tổng, vốn và hướng lệnh dựa trên lý do đóng thực tế.
 * @param {string} reason - Lý do đóng vị thế (TP Đã Khớp, SL Đã Khớp, v.v.).
 * @param {string} positionSide - Hướng vị thế đã đóng (LONG/SHORT).
 * @param {number} pnlValue - Giá trị PNL của giao dịch này.
 */
function updatePNLLogic(reason, positionSide, pnlValue) {
    if (pnlValue > 0) {
        totalProfit += pnlValue;
    } else {
        totalLoss += Math.abs(pnlValue);
    }
    netPNL = totalProfit - totalLoss;

    addLog([
        `🔴 Đã đóng ${positionSide} ${TARGET_COIN_SYMBOL}`,
        `├─ Lý do: ${reason}`,
        `├─ PNL: ${pnlValue.toFixed(2)} USDT`,
        `├─ Tổng Lời: ${totalProfit.toFixed(2)} USDT`,
        `├─ Tổng Lỗ: ${totalLoss.toFixed(2)} USDT`,
        `└─ PNL Ròng: ${netPNL.toFixed(2)} USDT`
    ].join('\n'));

    // Cập nhật vốn và hướng lệnh dựa trên lý do đóng đã xác định
    if (reason.includes('TP Đã Khớp')) {
        consecutiveLossCount = 0;
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        nextTradeDirection = positionSide; // Giữ nguyên hướng lệnh
        addLog(`Đã đạt TP. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
    } else if (reason.includes('SL Đã Khớp') || reason.includes('kích hoạt ngay') || reason.includes('Vị thế sót')) { // Bao gồm cả các trường hợp lỗi kích hoạt ngay
        if (APPLY_DOUBLE_STRATEGY) {
            consecutiveLossCount++;
            addLog(`Đã chạm SL. Số lần lỗ liên tiếp: ${consecutiveLossCount}.`);
            if (consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
                consecutiveLossCount = 0;
                addLog(`Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0.`);
            } else {
                currentInvestmentAmount *= 2;
                addLog(`Gấp đôi vốn cho lệnh tiếp theo: ${currentInvestmentAmount} USDT.`);
            }
        } else {
            addLog(`Đã chạm SL. Không áp dụng chiến lược x2 vốn.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
        }
        nextTradeDirection = (positionSide === 'LONG' ? 'SHORT' : 'LONG'); // Đảo ngược hướng lệnh
        addLog(`Lệnh tiếp theo: ${nextTradeDirection}.`);
    } else { // Các lý do đóng khác (ví dụ: đóng thủ công, lỗi không rõ, không đủ số dư)
        // Giả định là một trường hợp cần reset trạng thái về ban đầu
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = (positionSide === 'LONG' ? 'SHORT' : 'LONG'); // Vẫn đảo chiều nếu lý do không rõ là do lỗi
        addLog(`Lệnh đóng do lý do đặc biệt (${reason}). Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
    }
}


/**
 * Hàm đóng vị thế hiện tại và xử lý logic PNL, vốn, hướng lệnh
 * Đảm bảo 100% xác nhận TP/SL bằng cách lấy dữ liệu từ userTrades.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng vị thế cần đóng.
 * @param {string} reason - Lý do ban đầu của việc đóng vị thế (TP, SL, Hết thời gian, Manual, v.v.).
 */
async function closePosition(symbol, quantity, reason) {
    if (isClosingPosition) {
        addLog(`[DEBUG] Đang trong quá trình đóng vị thế. Bỏ qua yêu cầu đóng mới.`);
        return;
    }
    isClosingPosition = true; // Đặt cờ để ngăn các lệnh đóng chồng chéo

    const positionSideBeforeClose = currentOpenPosition?.side; // Lấy hướng vị thế trước khi đóng

    addLog(`[DEBUG] Bắt đầu quá trình đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantity}.`);

    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`);
            isClosingPosition = false;
            return;
        }
        const quantityPrecision = symbolInfo.quantityPrecision;
        const tickSize = symbolInfo.tickSize; // Lấy tickSize từ symbolInfo

        // Kiểm tra vị thế hiện tại trên Binance TRƯỚC KHI gửi lệnh đóng
        const initialPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const initialPositionOnBinance = initialPositions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (initialPositionOnBinance && Math.abs(parseFloat(initialPositionOnBinance.positionAmt)) > 0) {
            const actualQuantityToClose = Math.abs(parseFloat(initialPositionOnBinance.positionAmt));
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

            // Xác định 'side' để đóng vị thế hiện tại
            const closeSide = (parseFloat(initialPositionOnBinance.positionAmt) < 0) ? 'BUY' : 'SELL'; // BUY để đóng SHORT, SELL để đóng LONG

            addLog(`Gửi lệnh đóng ${positionSideBeforeClose}: ${symbol}, ${closeSide}, MARKET, Qty: ${adjustedActualQuantity}`);

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: 'true' // Đảm bảo lệnh này chỉ dùng để giảm vị thế
            });

            addLog(`Đã gửi lệnh đóng ${positionSideBeforeClose} ${symbol}.`);
        } else {
            addLog(`Vị thế ${symbol} đã đóng trên sàn hoặc không có vị thế khi bắt đầu đóng. Lý do: ${reason}.`);
        }

        // --- BẮT ĐẦU PHẦN KIỂM TRA CHẮC CHẮN 100% SAU KHI GỬI LỆNH ĐÓNG ---
        addLog(`Đang đợi 1 giây để xác nhận vị thế ${symbol} đã đóng hoàn toàn...`);
        await sleep(1000); // Đợi 1 giây để Binance xử lý hoàn tất lệnh đóng và cập nhật trạng thái

        const finalPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const finalPositionOnBinance = finalPositions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        let actualClosePrice = null;
        let finalCloseReason = "Đóng thủ công/Lỗi không rõ"; // Lý do mặc định nếu không xác định được TP/SL
        let pnlForCalculation = 0; // PNL thực tế để tính toán

        if (!finalPositionOnBinance || parseFloat(finalPositionOnBinance.positionAmt) === 0) {
            // --- VỊ THẾ ĐÃ ĐÓNG TRÊN BINANCE! ---
            addLog(`Xác nhận: Vị thế ${symbol} đã đóng hoàn toàn trên sàn.`);

            // Lấy các giao dịch gần nhất cho symbol này
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, limit: 20 }); // Lấy nhiều hơn để đảm bảo tìm thấy

            if (recentTrades && recentTrades.length > 0) {
                recentTrades.sort((a, b) => b.time - a.time); // Sắp xếp theo thời gian giảm dần (mới nhất lên đầu)

                // Tìm giao dịch khớp với việc đóng vị thế (mua nếu là SHORT, bán nếu là LONG)
                // Lọc các giao dịch có isMaker=false (taker order) để tìm lệnh đóng market của bot
                const closingTrade = recentTrades.find(t =>
                    (positionSideBeforeClose === 'LONG' && t.side === 'SELL' && t.isMaker === false && Math.abs(parseFloat(t.qty) - quantity) < 0.0001) || // Kiểm tra số lượng gần đúng
                    (positionSideBeforeClose === 'SHORT' && t.side === 'BUY' && t.isMaker === false && Math.abs(parseFloat(t.qty) - quantity) < 0.0001)
                );

                if (closingTrade) {
                    actualClosePrice = parseFloat(closingTrade.price);
                    pnlForCalculation = (positionSideBeforeClose === 'LONG')
                        ? (actualClosePrice - currentOpenPosition.entryPrice) * currentOpenPosition.quantity
                        : (currentOpenPosition.entryPrice - actualClosePrice) * currentOpenPosition.quantity;

                    // So sánh giá đóng thực tế với TP/SL ban đầu bằng ngưỡng tickSize
                    // Dùng ngưỡng 3 lần tickSize để tăng độ tin cậy
                    if (positionSideBeforeClose === 'LONG') {
                        if (actualClosePrice >= (currentOpenPosition.initialTPPrice - tickSize * 3) && pnlForCalculation > 0) {
                            finalCloseReason = "TP Đã Khớp";
                        } else if (actualClosePrice <= (currentOpenPosition.initialSLPrice + tickSize * 3) && pnlForCalculation < 0) {
                            finalCloseReason = "SL Đã Khớp";
                        } else {
                            finalCloseReason = reason; // Sử dụng lý do ban đầu nếu không khớp TP/SL rõ ràng
                        }
                    } else { // SHORT
                        if (actualClosePrice <= (currentOpenPosition.initialTPPrice + tickSize * 3) && pnlForCalculation > 0) {
                            finalCloseReason = "TP Đã Khớp";
                        } else if (actualClosePrice >= (currentOpenPosition.initialSLPrice - tickSize * 3) && pnlForCalculation < 0) {
                            finalCloseReason = "SL Đã Khớp";
                        } else {
                            finalCloseReason = reason; // Sử dụng lý do ban đầu nếu không khớp TP/SL rõ ràng
                        }
                    }
                    addLog(`[DEBUG] Giá đóng thực tế: ${actualClosePrice.toFixed(symbolInfo.pricePrecision)}. Lý do suy luận: ${finalCloseReason}`);
                } else {
                    addLog(`[DEBUG] Không tìm thấy giao dịch đóng lệnh chính xác trong userTrades gần đây cho ${symbol}. Sử dụng lý do ban đầu: ${reason}.`);
                    // Ước tính PNL nếu không tìm thấy giao dịch chính xác (ít lý tưởng)
                    pnlForCalculation = (reason.includes('TP')) ? currentOpenPosition.initialMargin * TAKE_PROFIT_PERCENTAGE_MAIN
                                       : (reason.includes('SL')) ? -currentOpenPosition.initialMargin * STOP_LOSS_PERCENTAGE_MAIN
                                       : 0;
                }
            } else {
                addLog(`[DEBUG] Không có giao dịch gần đây nào cho ${symbol} để xác định lý do đóng. Sử dụng lý do ban đầu: ${reason}.`);
                 // Ước tính PNL nếu không có giao dịch (ít lý tưởng)
                pnlForCalculation = (reason.includes('TP')) ? currentOpenPosition.initialMargin * TAKE_PROFIT_PERCENTAGE_MAIN
                                   : (reason.includes('SL')) ? -currentOpenPosition.initialMargin * STOP_LOSS_PERCENTAGE_MAIN
                                   : 0;
            }

            // Gọi hàm để cập nhật PNL và logic vốn/hướng lệnh
            updatePNLLogic(finalCloseReason, positionSideBeforeClose, pnlForCalculation);

            // --- Sau khi xác định xong lý do và cập nhật PNL ---
            currentOpenPosition = null; // CHẮC CHẮN reset trạng thái bot để mở lệnh mới
            addLog(`[DEBUG] currentOpenPosition được đặt thành NULL.`);
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
                addLog(`[DEBUG] Đã xóa positionCheckInterval.`);
            }
            await cancelOpenOrdersForSymbol(symbol); // Hủy mọi lệnh chờ còn lại cho symbol này
            if (botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ chính ngay lập tức để mở lệnh mới

        } else {
            // --- CẢNH BÁO: VỊ THẾ VẪN CÒN TỒN TẠI TRÊN BINANCE SAU KHI ĐÃ CỐ GẮNG ĐÓNG ---
            addLog(`🔴 Cảnh báo nghiêm trọng: Vị thế ${symbol} vẫn còn tồn tại trên sàn sau khi gửi lệnh đóng!`);
            addLog(`[DEBUG] Vị thế còn sót: ${finalPositionOnBinance.positionAmt}. Cố gắng đóng lại.`);
            const remainingQuantity = Math.abs(parseFloat(finalPositionOnBinance.positionAmt));
            const estimatedSide = parseFloat(finalPositionOnBinance.positionAmt) < 0 ? 'SHORT' : 'LONG';
            // Cập nhật lại currentOpenPosition để hàm closePosition có thể xử lý lại
            currentOpenPosition = {
                symbol: symbol,
                quantity: remainingQuantity,
                entryPrice: parseFloat(finalPositionOnBinance.entryPrice),
                initialTPPrice: currentOpenPosition?.initialTPPrice || 0, // Giữ nguyên TP/SL ban đầu nếu có
                initialSLPrice: currentOpenPosition?.initialSLPrice || 0,
                initialMargin: currentOpenPosition?.initialMargin || 0,
                openTime: new Date(parseFloat(finalPositionOnBinance.updateTime)),
                pricePrecision: symbolInfo.pricePrecision,
                side: estimatedSide
            };
            await closePosition(symbol, remainingQuantity, 'Vị thế sót sau đóng ban đầu'); // Gọi lại chính nó để đóng vị thế sót
        }

    } catch (error) {
        addLog(`Lỗi trong quá trình đóng vị thế ${symbol}: ${error.msg || error.message}`);
        // Nếu lỗi xảy ra, cần đảm bảo cờ isClosingPosition được reset để không bị kẹt
    } finally {
        isClosingPosition = false; // Reset cờ dù thành công hay thất bại
        addLog(`[DEBUG] isClosingPosition được đặt thành FALSE.`);
    }
}

// Hàm kiểm tra và quản lý vị thế đang mở (SL/TP)
// Hàm này chỉ kiểm tra vị thế trên sàn và gọi closePosition nếu vị thế không còn.
async function manageOpenPosition() {
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            addLog(`[DEBUG] manageOpenPosition: currentOpenPosition NULL, xóa interval.`);
            if (botRunning) scheduleNextMainCycle(); // Nếu bot đang chạy và không có vị thế, bắt đầu chu kỳ mới
        }
        return;
    }

    const { symbol } = currentOpenPosition; // Chỉ cần symbol để kiểm tra

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        // Nếu vị thế không còn trên sàn Binance
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`Vị thế ${symbol} không còn trên sàn Binance. Gọi hàm đóng để xử lý chi tiết PNL/vốn.`);
            // Gọi closePosition với thông tin currentOpenPosition hiện tại để nó xác nhận lý do đóng
            // Quan trọng: currentOpenPosition cần có đầy đủ thông tin để closePosition hoạt động
            await closePosition(symbol, currentOpenPosition.quantity, "Vị thế không còn trên sàn");
            return; // Dừng hàm manageOpenPosition sau khi xử lý đóng
        }
        // Nếu vị thế vẫn còn, không làm gì cả, interval sẽ gọi lại sau.
    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế.`);
        }
    }
}

// Hàm chờ một khoảng thời gian
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Hàm mở lệnh (Long hoặc Short)
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (currentOpenPosition) {
        addLog(`Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`);
        if (botRunning) scheduleNextMainCycle();
        return;
    }

    addLog(`Mở ${tradeDirection} ${symbol}.`);
    addLog(`Mở lệnh với số vốn: ${currentInvestmentAmount} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol); // Giá thị trường tại thời điểm gửi lệnh
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = currentInvestmentAmount;

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${nextTradeDirection}.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty) {
            addLog(`Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) cho ${symbol}. Hủy.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        if (quantity <= 0) {
            addLog(`Qty cho ${symbol} là ${quantity}. Không hợp lệ. Hủy.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        // Gửi lệnh thị trường
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL'
        });

        addLog(`Đã gửi lệnh MARKET để mở ${tradeDirection} ${symbol}.`);

        // --- Đợi 1 giây để lệnh khớp và vị thế được cập nhật trên Binance ---
        addLog(`Đợi 1 giây để lệnh mở khớp và cập nhật vị thế trên Binance.`);
        await sleep(1000);

        // Lấy thông tin vị thế đang mở để có entryPrice chính xác
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            addLog(`Không tìm thấy vị thế mở cho ${symbol} sau 1 giây. Có thể lệnh không khớp hoặc đã đóng ngay lập tức. Sẽ thử lại.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt)); // Lấy số lượng thực tế của vị thế
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now())); // Thời gian cập nhật vị thế
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`Đã mở ${tradeDirection} ${symbol} lúc ${formattedOpenTime}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Ký quỹ: ${capitalToUse.toFixed(2)} USDT | Qty thực tế: ${actualQuantity} ${symbol} | Giá vào thực tế: ${entryPrice.toFixed(pricePrecision)}`);

        // --- Hủy tất cả các lệnh chờ hiện tại (TP/SL) nếu có trước khi đặt lại ---
        await cancelOpenOrdersForSymbol(symbol);
        addLog(`Đã hủy các lệnh chờ cũ (nếu có) cho ${symbol}.`);

        // --- BẮT ĐẦU TÍNH TOÁN TP/SL THEO % VỐN (dùng giá vào lệnh thực tế và số lượng thực tế) ---
        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_PERCENTAGE_MAIN;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_PERCENTAGE_MAIN;

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        if (tradeDirection === 'LONG') {
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            slOrderSide = 'SELL';
            tpOrderSide = 'SELL';

            slPrice = Math.floor(slPrice / tickSize) * tickSize; // Làm tròn xuống
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize; // Làm tròn xuống

        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            slOrderSide = 'BUY';
            tpOrderSide = 'BUY';

            slPrice = Math.ceil(slPrice / tickSize) * tickSize; // Làm tròn lên
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize; // Làm tròn lên
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

        // Đặt lệnh SL
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: slOrderSide,
                type: 'STOP_MARKET',
                quantity: actualQuantity,
                stopPrice: slPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            addLog(`Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`);
        } catch (slError) {
            addLog(`Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}.`);
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${symbol}. Gọi hàm đóng để xử lý.`);
                await closePosition(symbol, actualQuantity, 'SL kích hoạt ngay');
                return;
            }
        }

        // Đặt lệnh TP
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: tpOrderSide,
                type: 'TAKE_PROFIT_MARKET',
                quantity: actualQuantity,
                stopPrice: tpPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            addLog(`Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`);
        } catch (tpError) {
            addLog(`Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}.`);
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${symbol}. Gọi hàm đóng để xử lý.`);
                await closePosition(symbol, actualQuantity, 'TP kích hoạt ngay');
                return;
            }
        }

        // Lưu trạng thái vị thế đang mở
        currentOpenPosition = {
            symbol: symbol,
            quantity: actualQuantity,
            entryPrice: entryPrice,
            initialTPPrice: tpPrice,
            initialSLPrice: slPrice,
            initialMargin: capitalToUse,
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection
        };
        addLog(`[DEBUG] currentOpenPosition được đặt: ${symbol} ${tradeDirection} @ ${entryPrice.toFixed(pricePrecision)}.`);


        // Khởi động interval kiểm tra vị thế nếu chưa có
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                        if (error instanceof CriticalApiError) {
                            addLog(`Bot dừng do lỗi API nghiêm trọng trong kiểm tra vị thế.`);
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
                    addLog(`[DEBUG] positionCheckInterval bị xóa do bot dừng.`);
                }
            }, 300); // Tần suất kiểm tra vị thế
            addLog(`[DEBUG] Đã khởi động positionCheckInterval.`);
        }

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`);
            stopBotLogicInternal();
            if (!retryBotTimeout) {
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...');
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else if (botRunning) {
            // Nếu không phải lỗi nghiêm trọng, lên lịch chu kỳ tiếp theo để thử lại
            scheduleNextMainCycle();
        }
    }
}

// Hàm chạy logic tìm kiếm cơ hội (chỉ chạy khi không có lệnh mở)
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét.');
        return;
    }

    if (currentOpenPosition) {
        addLog('Có vị thế mở. Bỏ qua quét mới.');
        return;
    }

    addLog(`Cố gắng mở lệnh ${TARGET_COIN_SYMBOL} không phanh...`);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        const targetSymbol = TARGET_COIN_SYMBOL;
        let eligibleSymbol = null;

        const symbolDetails = await getSymbolDetails(targetSymbol);
        if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
            const currentPrice = await getCurrentPrice(targetSymbol);
            if (currentPrice === null) {
                addLog(`Lỗi lấy giá cho ${targetSymbol}. Bỏ qua. Sẽ thử lại ngay.`);
            } else {
                let estimatedQuantity = (currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
                estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                const currentNotional = estimatedQuantity * currentPrice;

                if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                    eligibleSymbol = {
                        symbol: targetSymbol,
                        maxLeverage: symbolDetails.maxLeverage
                    };
                } else {
                    addLog(`${targetSymbol}: KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh (minNotional/minQty). Sẽ thử lại ngay.`);
                }
            }
        } else {
            addLog(`${targetSymbol}: Không có đòn bẩy hợp lệ hoặc không tìm thấy symbol. Sẽ thử lại ngay.`);
        }

        if (availableBalance < currentInvestmentAmount) {
            addLog(`Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh (${currentInvestmentAmount.toFixed(2)} USDT). Trở về lệnh ban đầu.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${nextTradeDirection}.`);
            scheduleNextMainCycle();
            return;
        }

        if (eligibleSymbol) {
            addLog(`\nChọn: ${eligibleSymbol.symbol}`);
            addLog(`  + Đòn bẩy: ${eligibleSymbol.maxLeverage}x | Vốn: ${currentInvestmentAmount.toFixed(2)} USDT`);
            addLog(`Mở lệnh ${nextTradeDirection} ngay lập tức.`);

            await openPosition(eligibleSymbol.symbol, nextTradeDirection, availableBalance, eligibleSymbol.maxLeverage);

        } else {
            addLog(`Không thể mở lệnh ${nextTradeDirection} cho ${targetSymbol}. Sẽ thử lại ngay.`);
            if (botRunning) scheduleNextMainCycle();
        }
    } catch (error) {
        addLog('Lỗi trong chu kỳ giao dịch: ' + (error.msg || error.message));
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            stopBotLogicInternal();
            retryBotTimeout = setTimeout(async () => {
                addLog('Thử khởi động lại bot...');
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        } else {
            if (botRunning) scheduleNextMainCycle();
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot (đã bỏ delay)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Không lên lịch chu kỳ mới.');
        clearTimeout(nextScheduledCycleTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('Có vị thế mở. Chờ đóng vị thế hiện tại.');
        // Nếu có vị thế mở, manageOpenPosition sẽ được gọi bởi interval.
        // runTradingLogic chỉ chạy khi không có vị thế mở.
        // Không cần lên lịch chạy lại runTradingLogic ngay nếu có vị thế mở.
        return;
    }

    clearTimeout(nextScheduledCycleTimeout);

    // Chạy logic giao dịch ngay lập tức nếu không có vị thế mở
    addLog(`[DEBUG] Lên lịch chạy runTradingLogic ngay lập tức.`);
    await runTradingLogic();
}


// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đang chạy.');
        return 'Bot đang chạy.';
    }

    if (!API_KEY || !SECRET_KEY) {
        addLog('Lỗi: API Key hoặc Secret Key chưa được cấu hình.');
        return 'Lỗi: API Key hoặc Secret Key chưa được cấu hình.';
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

        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtAsset).toFixed(2)}`);

        consecutiveApiErrors = 0;

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('Lỗi tải exchangeInfo. Bot dừng.');
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Vốn ban đầu cho mỗi lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);

        // Đảm bảo các biến trạng thái được reset đúng cách khi khởi động
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT'; // Đặt hướng mặc định khi khởi động
        // Reset PNL khi khởi động mới
        totalProfit = 0;
        totalLoss = 0;
        netPNL = 0;


        // Chỉ khởi động positionCheckInterval nếu chưa có
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                        if (error instanceof CriticalApiError) {
                            addLog(`Bot dừng do lỗi API trong kiểm tra vị thế.`);
                            stopBotLogicInternal();
                            if (!retryBotTimeout) { // Chỉ lên lịch nếu chưa có lịch khác
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
            }, 300); // Tần suất kiểm tra vị thế
        }

        // Kích hoạt chu kỳ chính sau khi khởi động thành công
        scheduleNextMainCycle();

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('[Lỗi khởi động bot] ' + errorMsg);
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.');

        stopBotLogicInternal(); // Dừng bot nếu khởi động thất bại
        if (error instanceof CriticalApiError && !retryBotTimeout) { // Chỉ lên lịch nếu lỗi nghiêm trọng và chưa có lịch khác
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
    consecutiveApiErrors = 0;
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.');
    }
    addLog('--- Bot đã dừng ---');
    botStartTime = null;
    return 'Bot đã dừng.';
}

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();
app.use(express.json()); // Để parse JSON trong body của request POST

app.get('/', (req, res) => {
    // Đảm bảo index.html nằm cùng cấp hoặc đúng đường dẫn
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi đọc log file:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}.`);
            }
            return res.status(500).send('Lỗi đọc log file');
        }
        // Xóa các ký tự mã màu ANSI (thường do PM2 hoặc các thư viện khác tạo ra)
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        const lines = cleanData.split('\n');
        const maxDisplayLines = 500; // Giới hạn số dòng log hiển thị
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

        let statusMessage = 'MAY CHU: KHONG TIM THAY TIEN TRINH PM2'; // Trạng thái mặc định nếu không tìm thấy
        let botRunningStatus = botRunning ? 'DANG CHAY' : 'DA DUNG';
        let uptimeString = '';
        if (botStartTime) {
            const uptimeMs = Date.now() - botStartTime.getTime();
            const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
            const hours = Math.floor(uptimeMinutes / 60);
            const minutes = uptimeMinutes % 60;
            uptimeString = ` | DA CHAY: ${hours}h ${minutes}p`;
        }

        if (botProcess) {
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI BOT: ${botRunningStatus}${uptimeString}`;
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME}) | TRANG THAI BOT: ${botRunningStatus}${uptimeString}`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error.message || error})`);
    }
});

// Endpoint để cấu hình các tham số từ frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinSymbol, initialAmount, applyDoubleStrategy } = req.body;

    API_KEY = apiKey.trim();
    SECRET_KEY = secretKey.trim();
    TARGET_COIN_SYMBOL = coinSymbol.trim().toUpperCase(); // Đảm bảo luôn là chữ hoa
    INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount);
    APPLY_DOUBLE_STRATEGY = !!applyDoubleStrategy; // Chuyển sang boolean

    // Cập nhật currentInvestmentAmount ngay lập tức
    currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
    consecutiveLossCount = 0; // Reset khi cấu hình lại
    nextTradeDirection = 'SHORT'; // Reset khi cấu hình lại
    totalProfit = 0; // Reset PNL khi cấu hình lại
    totalLoss = 0;
    netPNL = 0;

    addLog(`Đã cập nhật cấu hình:`);
    addLog(`  API Key: ${API_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Secret Key: ${SECRET_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Đồng coin: ${TARGET_COIN_SYMBOL}`);
    addLog(`  Số vốn ban đầu: ${INITIAL_INVESTMENT_AMOUNT} USDT`);
    addLog(`  Chiến lược x2 vốn: ${APPLY_DOUBLE_STRATEGY ? 'Bật' : 'Tắt'}`);

    res.json({ success: true, message: 'Cấu hình đã được cập nhật.' });
});

app.get('/api/pnl', (req, res) => {
    res.json({
        totalProfit: totalProfit.toFixed(2),
        totalLoss: totalLoss.toFixed(2),
        netPNL: netPNL.toFixed(2)
    });
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
