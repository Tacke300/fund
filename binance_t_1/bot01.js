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

// Tổng PNL để hiển thị
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message, code = 'UNKNOWN') {
        super(message);
        this.name = 'CriticalApiError';
        this.code = code;
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH (GIÁ TRỊ MẶC ĐỊNH) ---
let INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 10 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'ETHUSDT'; // Mặc định NEIROUSDT (sẽ được cập nhật từ UI)
let APPLY_DOUBLE_STRATEGY = false; // Mặc định false (sẽ được cập nhật từ UI)

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.60; // 60% lãi trên VỐN
const STOP_LOSS_PERCENTAGE_MAIN = 0.175;   // 17.5% lỗ trên VỐN

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

// Biến theo dõi vốn hiện tại cho lệnh
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
// Biến theo dõi số lần lỗ liên tiếp
let consecutiveLossCount = 0;
// Biến theo dõi hướng lệnh tiếp theo (SHORT là mặc định ban đầu)
let nextTradeDirection = 'SHORT'; 

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1234; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/tung01-out.log'; // Đã đổi tên theo PM2 output log
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
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;
        
        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return; // Bỏ qua nếu tin nhắn giống hệt đã được log gần đây
        } else {
            // Nếu đã qua cooldown và có lặp lại, ghi log số lần lặp
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            } else {
                console.log(logEntry); // Log lần đầu tiên
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        console.log(logEntry); // Log lần đầu tiên
    }
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
        throw new CriticalApiError("API Key hoặc Secret Key chưa được cấu hình.", 'NO_API_KEYS');
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
        consecutiveApiErrors = 0; // Reset lỗi liên tiếp khi thành công
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        const errorCode = error.code || 'UNKNOWN';
        const errorMessage = error.msg || error.message;
        addLog(`Lỗi ký API Binance: ${errorCode} - ${errorMessage}`); 
        if (errorCode === -2015) {
            addLog("  -> Kiểm tra API Key/Secret và quyền Futures."); 
        } else if (errorCode === -1021) {
            addLog("  -> Lỗi lệch thời gian. Đồng bộ đồng hồ máy tính."); 
        } else if (errorCode === -1022) {
            addLog("  -> Lỗi chữ ký. Kiểm tra API Key/Secret hoặc chuỗi tham số."); 
        } else if (errorCode === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai."); 
        } else if (errorCode === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng."); 
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors} lần). Dừng bot.`, true); 
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.", errorCode); 
        }
        throw error; // Ném lại lỗi để caller xử lý (ví dụ: `startBotLogicInternal` sẽ bắt)
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
        consecutiveApiErrors = 0; // Reset lỗi liên tiếp khi thành công
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        const errorCode = error.code || 'UNKNOWN';
        const errorMessage = error.msg || error.message;
        addLog(`Lỗi công khai API Binance: ${errorCode} - ${errorMessage}`); 
        if (errorCode === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai."); 
        } else if (errorCode === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng."); 
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp (${consecutiveApiErrors} lần). Dừng bot.`, true); 
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.", errorCode); 
        }
        throw error; // Ném lại lỗi để caller xử lý
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
        serverTimeOffset = 0; // Đặt về 0 để tránh lỗi timestamp thêm
        throw error; // Ném lỗi để bắt ở cấp cao hơn
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
        throw error; // Ném lỗi để caller xử lý
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
        throw error; // Ném lỗi để bắt ở cấp cao hơn
    }
}

// Hàm kết hợp để lấy tất cả filters và maxLeverage cho một symbol
async function getSymbolDetails(symbol) {
    try {
        const filters = await getExchangeInfo();
        if (!filters || !filters[symbol]) {
            addLog(`Không tìm thấy filters cho ${symbol}.`);
            return null;
        }
        const maxLeverage = await getLeverageBracketForSymbol(symbol);
        return { ...filters[symbol], maxLeverage: maxLeverage };
    } catch (error) {
        // Lỗi đã được log trong các hàm con, chỉ cần ném lại
        throw error;
    }
}

// Lấy giá hiện tại của một symbol
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        // Lỗi đã được log trong callPublicAPI, chỉ cần trả về null hoặc ném lại nếu muốn lỗi nghiêm trọng
        return null;
    }
}

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`Hủy tất cả lệnh chờ cho ${symbol}...`);
        const result = await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`Đã hủy ${result.length} lệnh chờ cho ${symbol}.`);
    } catch (error) {
        addLog(`Lỗi hủy lệnh chờ cho ${symbol}: ${error.msg || error.message}`);
        // Không ném lỗi CriticalApiError ở đây trừ khi nó thật sự ngăn cản bot hoạt động
    }
}

/**
 * Cập nhật trạng thái bot sau khi đóng vị thế, xử lý PNL, vốn và hướng lệnh tiếp theo.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng vị thế đã đóng.
 * @param {string} reason - Lý do đóng vị thế (e.g., "TP khớp", "SL khớp", "Thủ công", "Vị thế sót").
 */
async function processClosedPosition(symbol, quantity, reason) {
    addLog(`Đang xử lý logic sau khi đóng vị thế ${symbol} (Lý do: ${reason}).`);

    let pnl = 0;
    let positionSideBeforeClose = currentOpenPosition?.side; // Lấy hướng lệnh trước khi reset currentOpenPosition

    if (currentOpenPosition) {
        // Cố gắng tính PNL nếu có thông tin vị thế đầy đủ
        const entryPrice = currentOpenPosition.entryPrice;
        const closePrice = await getCurrentPrice(symbol);
        
        if (closePrice) {
            pnl = (currentOpenPosition.side === 'LONG')
                ? (closePrice - entryPrice) * quantity
                : (entryPrice - closePrice) * quantity;
        } else {
            addLog(`Không lấy được giá đóng lệnh cho ${symbol}. Không thể tính PNL chính xác.`);
        }
        
        // Cập nhật tổng lời/lỗ
        if (pnl > 0) {
            totalProfit += pnl;
        } else {
            totalLoss += Math.abs(pnl);
        }
        netPNL = totalProfit - totalLoss;

        // Log PNL
        addLog([
            `🔴 Đã đóng ${positionSideBeforeClose || 'UNKNOWN'} ${symbol}`,
            `├─ Lý do: ${reason}`,
            `├─ PNL: ${pnl.toFixed(2)} USDT`,
            `├─ Tổng Lời: ${totalProfit.toFixed(2)} USDT`,
            `├─ Tổng Lỗ: ${totalLoss.toFixed(2)} USDT`,
            `└─ PNL Ròng: ${netPNL.toFixed(2)} USDT`
        ].join('\n'));
    } else {
        addLog(`Đóng vị thế ${symbol} nhưng không có thông tin currentOpenPosition. Không tính PNL.`);
    }

    // XỬ LÝ LOGIC VỐN & HƯỚNG LỆNH TIẾP THEO
    if (reason.includes("TP")) {
        consecutiveLossCount = 0;
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        nextTradeDirection = positionSideBeforeClose; // GIỮ NGUYÊN HƯỚNG
        addLog(`💰 TP - Giữ hướng: ${nextTradeDirection}. Reset vốn về ${currentInvestmentAmount} USDT.`);
    } 
    else if (reason.includes("SL") || reason.includes("Hết thời gian") || reason.includes("kích hoạt ngay")) {
        if (APPLY_DOUBLE_STRATEGY) {
            consecutiveLossCount++;
            addLog(`Đã chạm SL/Hết thời gian. Số lần lỗ liên tiếp: ${consecutiveLossCount}.`);
            if (consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; 
                consecutiveLossCount = 0;
                addLog(`Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0.`);
            } else {
                currentInvestmentAmount *= 2; 
                addLog(`Gấp đôi vốn cho lệnh tiếp theo: ${currentInvestmentAmount} USDT.`);
            }
        } else {
             addLog(`Đã chạm SL/Hết thời gian. Không áp dụng chiến lược x2 vốn.`);
             currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; 
             consecutiveLossCount = 0; 
        }
        nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); // ĐẢO CHIỀU
        addLog(`💸 SL/Hết thời gian - Đảo chiều thành: ${nextTradeDirection}.`);
    } else {
        // Các lý do đóng khác (ví dụ: đóng thủ công, lỗi không rõ, không đủ số dư)
        // Giả định là một trường hợp cần reset trạng thái về ban đầu
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        // Đảo chiều nếu lý do không rõ là do lỗi (hoặc giữ nguyên nếu muốn)
        nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); 
        addLog(`Lệnh đóng do lý do đặc biệt (${reason}). Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
    }

    currentOpenPosition = null; // Reset vị thế đang mở
    if (positionCheckInterval) { // Dừng kiểm tra vị thế định kỳ
        clearInterval(positionCheckInterval); 
        positionCheckInterval = null;
    }
    // Không gọi scheduleNextMainCycle() ngay lập tức, hàm `closePosition` sẽ gọi sau khi hoàn thành.
}

/**
 * Gửi lệnh đóng vị thế hiện tại trên Binance.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng muốn đóng.
 * @param {string} reason - Lý do đóng lệnh.
 */
async function closePosition(symbol, quantity, reason) {
    if (isClosingPosition) {
        addLog(`Đang trong quá trình đóng vị thế. Bỏ qua lệnh đóng cho ${symbol}.`);
        return;
    }
    isClosingPosition = true;
    
    addLog(`Đang đóng lệnh ${currentOpenPosition?.side || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantity}.`); 
    
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không thể đóng lệnh.`); 
            isClosingPosition = false;
            if(botRunning) scheduleNextMainCycle(); // Cố gắng chạy lại chu kỳ chính
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} đã đóng trên sàn hoặc không có vị thế. Lý do: ${reason}.`); 
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

            // Xác định 'side' để đóng vị thế hiện tại (BUY để đóng SHORT, SELL để đóng LONG)
            const closeSide = (parseFloat(currentPositionOnBinance.positionAmt) < 0) ? 'BUY' : 'SELL'; 

            addLog(`Gửi lệnh đóng: ${symbol}, ${closeSide}, MARKET, Qty: ${adjustedActualQuantity}`); 

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: 'true' // Đảm bảo lệnh này chỉ giảm vị thế
            });

            addLog(`Đã gửi lệnh đóng ${closeSide} ${symbol} (thực tế ${actualQuantityToClose}). Lý do: ${reason}.`); 
        }
        
        // Sau khi gửi lệnh đóng, hủy các lệnh chờ (TP/SL) cũ
        await cancelOpenOrdersForSymbol(symbol);
        
        // Chờ một chút và kiểm tra lại vị thế để đảm bảo đã đóng hoàn toàn
        await sleep(500); // Đợi 0.5 giây để sàn xử lý
        await checkAndHandleRemainingPosition(symbol); // Kiểm tra và xử lý vị thế sót

        // Xử lý logic PNL và trạng thái bot sau khi đã xác nhận đóng lệnh trên sàn
        await processClosedPosition(symbol, quantity, reason);

    } catch (error) {
        addLog(`Lỗi khi cố gắng đóng vị thế ${symbol}: ${error.msg || error.message}`);
        // Nếu lỗi nghiêm trọng trong quá trình đóng, có thể cần dừng bot tạm thời
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi đóng lệnh.`); 
            stopBotLogicInternal(); // Dừng bot nếu lỗi API quá nặng
            if (!retryBotTimeout) { // Chỉ lên lịch retry nếu chưa có
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`); 
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...'); 
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        }
    } finally {
        isClosingPosition = false;
        if(botRunning && !currentOpenPosition) { // Nếu bot đang chạy và không có vị thế, lịch trình chu kỳ mới
            scheduleNextMainCycle();
        }
    }
}

// Hàm kiểm tra và xử lý vị thế còn sót lại
async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Kiểm tra vị thế còn sót cho ${symbol}...`); 
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const positionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';
            addLog(`Vị thế ${symbol} còn sót: ${currentPositionAmount} (${positionSide}). Cố gắng đóng lại.`); 
            
            // Cố gắng đóng vị thế sót
            const estimatedSide = currentPositionAmount < 0 ? 'SHORT' : 'LONG';
            // Tạo tạm currentOpenPosition để hàm processClosedPosition có thể tính PNL nếu cần
            currentOpenPosition = { 
                symbol: symbol,
                quantity: Math.abs(currentPositionAmount),
                entryPrice: parseFloat(remainingPosition.entryPrice),
                initialTPPrice: 0, initialSLPrice: 0, initialMargin: 0, 
                openTime: new Date(parseFloat(remainingPosition.updateTime)), 
                pricePrecision: (exchangeInfoCache[symbol] ? exchangeInfoCache[symbol].pricePrecision : 8), 
                side: estimatedSide
            };
            await closePosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót');
        } else {
            addLog(`Đã xác nhận không còn vị thế ${symbol}.`); 
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`); 
        if (error instanceof CriticalApiError) {
            // Nếu lỗi nghiêm trọng, xử lý tương tự như khi đóng lệnh
            addLog(`Bot dừng do lỗi API nghiêm trọng khi kiểm tra vị thế sót.`); 
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

// Hàm chờ một khoảng thời gian
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Hàm mở lệnh (Long hoặc Short)
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (currentOpenPosition) {
        addLog(`Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`); 
        if(botRunning) scheduleNextMainCycle(); // Lên lịch chu kỳ mới ngay lập tức
        return;
    }
    if (!botRunning) {
        addLog(`Bot đã dừng. Không mở lệnh.`);
        return;
    }

    addLog(`Đang chuẩn bị mở lệnh ${tradeDirection} ${symbol} với vốn: ${currentInvestmentAmount} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        
        // Đặt đòn bẩy
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol); // Giá thị trường tại thời điểm gửi lệnh
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`); 

        const capitalToUse = currentInvestmentAmount; 

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}).`); 
            // Reset về lệnh ban đầu khi không đủ số dư để tránh kẹt
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${nextTradeDirection}.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice; 
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty || quantity <= 0) {
            addLog(`Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) hoặc <= 0 cho ${symbol}. Hủy.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`); 
            if(botRunning) scheduleNextMainCycle(); 
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
        await sleep(1000); 
        addLog(`Đã đợi 1 giây sau khi gửi lệnh mở. Đang lấy giá vào lệnh thực tế từ Binance.`);

        // Lấy thông tin vị thế đang mở để có entryPrice chính xác
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            addLog(`Không tìm thấy vị thế mở cho ${symbol} sau 1 giây. Có thể lệnh không khớp hoặc đã đóng ngay lập tức.`);
            // Nếu không tìm thấy vị thế, có thể do lệnh bị từ chối hoặc khớp quá nhanh và đã đóng
            // Cần reset lại để thử mở lệnh mới trong chu kỳ tiếp theo
            if(botRunning) scheduleNextMainCycle(); 
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

        // Tính giá TP/SL
        // priceChangeForTP = PNL_mong_muon / so_luong_thuc_te
        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        if (tradeDirection === 'LONG') {
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            slOrderSide = 'SELL'; 
            tpOrderSide = 'SELL'; 
        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            slOrderSide = 'BUY'; 
            tpOrderSide = 'BUY'; 
        }

        // Làm tròn giá theo tickSize
        slPrice = (tradeDirection === 'LONG') ? Math.floor(slPrice / tickSize) * tickSize : Math.ceil(slPrice / tickSize) * tickSize; 
        tpPrice = (tradeDirection === 'LONG') ? Math.floor(tpPrice / tickSize) * tickSize : Math.ceil(tpPrice / tickSize) * tickSize; 

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`TP dự kiến: ${tpPrice.toFixed(pricePrecision)}, SL dự kiến: ${slPrice.toFixed(pricePrecision)}`); 

        // Đặt lệnh SL
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: slOrderSide, 
                type: 'STOP_MARKET', // Lệnh STOP_MARKET
                quantity: actualQuantity, 
                stopPrice: slPrice, // Giá kích hoạt
                closePosition: 'true', 
                newOrderRespType: 'FULL'
            });
            addLog(`Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`); 
        } catch (slError) {
            addLog(`Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}.`); 
            // Nếu SL kích hoạt ngay lập tức
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, 'SL kích hoạt ngay');
                return; // Thoát để không đặt TP nữa
            }
        }

        // Đặt lệnh TP
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: tpOrderSide, 
                type: 'TAKE_PROFIT_MARKET', // Lệnh TAKE_PROFIT_MARKET
                quantity: actualQuantity, 
                stopPrice: tpPrice, // Giá kích hoạt
                closePosition: 'true', 
                newOrderRespType: 'FULL'
            });
            addLog(`Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`); 
        } catch (tpError) {
            addLog(`Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}.`); 
            // Nếu TP kích hoạt ngay lập tức
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, 'TP kích hoạt ngay');
                return; // Thoát
            }
        }

        // Cập nhật thông tin vị thế hiện tại của bot
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

        // Bắt đầu kiểm tra vị thế định kỳ nếu chưa có
        if(!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) { 
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`); 
                        if(error instanceof CriticalApiError) {
                            addLog(`Bot dừng do lỗi API nghiêm trọng trong kiểm tra vị thế định kỳ.`); 
                            stopBotLogicInternal();
                            if (!retryBotTimeout) { // Chỉ lên lịch retry nếu chưa có
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
                    clearInterval(positionCheckInterval); // Dừng interval nếu bot không chạy hoặc không có vị thế
                    positionCheckInterval = null;
                }
            }, 300); // Tần suất kiểm tra 300ms
        }

    } catch (error) {
        addLog(`Lỗi khi mở lệnh ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`); 
            stopBotLogicInternal(); // Dừng bot nếu lỗi API quá nặng
            if (!retryBotTimeout) { // Chỉ lên lịch retry nếu chưa có
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`); 
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...'); 
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else if(botRunning) { // Nếu không phải lỗi nghiêm trọng, lên lịch chu kỳ mới
            scheduleNextMainCycle(); 
        }
    }
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP)
 * Hàm này được gọi định kỳ bởi positionCheckInterval.
 */
async function manageOpenPosition() {
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) { 
            clearInterval(positionCheckInterval); // Dừng kiểm tra nếu không còn vị thế
            positionCheckInterval = null;
            if(botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ chính để tìm lệnh mới
        }
        return;
    }

    const { symbol, quantity, initialTPPrice, initialSLPrice, side } = currentOpenPosition; 

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        // Nếu vị thế không còn trên sàn Binance
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`Vị thế ${symbol} không còn trên sàn. Đang xác định lý do đóng.`);

            // Cố gắng suy luận lý do đóng từ các giao dịch gần đây
            // Lấy 5 giao dịch gần nhất
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, limit: 5 }); 
            let closeReason = "đã đóng trên sàn (lý do không rõ)"; 

            if (recentTrades.length > 0) {
                // Tìm giao dịch gần nhất có số lượng khớp với vị thế của chúng ta và là lệnh đóng
                const latestCloseTrade = recentTrades.find(t => 
                    (side === 'LONG' && t.side === 'SELL' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001) || // Long đóng bằng Sell
                    (side === 'SHORT' && t.side === 'BUY' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001)    // Short đóng bằng Buy
                );

                if (latestCloseTrade) {
                    const price = parseFloat(latestCloseTrade.price);
                    const tickSize = exchangeInfoCache[symbol]?.tickSize || 0.001; // Sử dụng tickSize từ cache

                    // Kiểm tra xem giá đóng có gần TP/SL ban đầu không
                    if (Math.abs(price - initialTPPrice) <= tickSize * 2) { 
                        closeReason = "TP khớp";
                    } else if (Math.abs(price - initialSLPrice) <= tickSize * 2) { 
                        closeReason = "SL khớp";
                    } else {
                        // Nếu không gần TP/SL, có thể là đóng thủ công hoặc lỗi khác
                        closeReason = "đóng thủ công / lý do khác";
                    }
                }
            }

            addLog(`Vị thế ${symbol} ${closeReason}. Cập nhật bot.`); 
            await closePosition(symbol, quantity, closeReason); 
            return;
        }

    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
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

        const symbolDetails = await getSymbolDetails(targetSymbol); // Hàm này có thể ném lỗi CriticalApiError
        if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
            const currentPrice = await getCurrentPrice(targetSymbol); // Hàm này có thể trả về null
            if (currentPrice === null) {
                addLog(`Lỗi lấy giá cho ${targetSymbol}. Bỏ qua. Sẽ thử lại ngay.`); 
                if(botRunning) scheduleNextMainCycle();
                return;
            } else {
                let estimatedQuantity = (currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
                estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                const currentNotional = estimatedQuantity * currentPrice;

                if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty && estimatedQuantity > 0) {
                    eligibleSymbol = {
                        symbol: targetSymbol,
                        maxLeverage: symbolDetails.maxLeverage 
                    };
                } else {
                    addLog(`${targetSymbol}: KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh (minNotional/minQty/quantity=${estimatedQuantity}). Sẽ thử lại ngay.`); 
                }
            }
        } else {
            addLog(`${targetSymbol}: Không có đòn bẩy hợp lệ hoặc không tìm thấy symbol trong exchangeInfo. Sẽ thử lại ngay.`); 
        }

        if (availableBalance < currentInvestmentAmount) {
            addLog(`Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh (${currentInvestmentAmount.toFixed(2)} USDT).`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${nextTradeDirection}.`);
            scheduleNextMainCycle(); // Thử lại ngay
            return;
        }
        
        if (eligibleSymbol) {
            addLog(`\nChọn: ${eligibleSymbol.symbol}`); 
            addLog(`  + Đòn bẩy: ${eligibleSymbol.maxLeverage}x | Vốn: ${currentInvestmentAmount.toFixed(2)} USDT`); 
            addLog(`Mở lệnh ${nextTradeDirection} ngay lập tức.`); 
            
            await openPosition(eligibleSymbol.symbol, nextTradeDirection, availableBalance, eligibleSymbol.maxLeverage);
            // openPosition sẽ tự lên lịch chu kỳ tiếp theo sau khi hoàn thành

        } else { 
            addLog(`Không thể mở lệnh ${nextTradeDirection} cho ${targetSymbol}. Sẽ thử lại ngay.`); 
            if(botRunning) scheduleNextMainCycle(); // Thử lại ngay
        }
    } catch (error) {
        addLog('Lỗi trong chu kỳ giao dịch (runTradingLogic): ' + (error.msg || error.message));
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`); 
            stopBotLogicInternal(); // Dừng bot
            if (!retryBotTimeout) { // Chỉ lên lịch retry nếu chưa có
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`); 
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...'); 
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else {
            if(botRunning) scheduleNextMainCycle(); // Thử lại ngay nếu không phải lỗi nghiêm trọng
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot (không delay)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Không lên lịch chu kỳ mới.'); 
        clearTimeout(nextScheduledCycleTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('Có vị thế mở. Chờ đóng vị thế hiện tại. Không lên lịch chu kỳ mới.'); 
        return; 
    }

    clearTimeout(nextScheduledCycleTimeout); // Xóa lịch trình cũ nếu có
    addLog(`Lên lịch chạy chu kỳ chính tiếp theo ngay lập tức.`);
    
    // Gọi trực tiếp runTradingLogic thay vì setTimeout để chạy ngay lập tức
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
        // Đồng bộ thời gian
        try {
            await syncServerTime();
        } catch (error) {
            addLog(`Lỗi khi đồng bộ thời gian lúc khởi động: ${error.message}.`);
            throw new CriticalApiError(`Không thể đồng bộ thời gian.`, error.code || 'TIME_SYNC_FAILED');
        }

        // Kiểm tra thông tin tài khoản
        let usdtBalance = 0;
        try {
            const account = await callSignedAPI('/fapi/v2/account', 'GET');
            usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
            addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`); 
        } catch (error) {
            addLog(`Lỗi khi lấy thông tin tài khoản lúc khởi động: ${error.msg || error.message}.`);
            throw new CriticalApiError(`Không thể lấy thông tin tài khoản.`, error.code || 'ACCOUNT_INFO_FAILED');
        }
        
        consecutiveApiErrors = 0; // Reset số lỗi API liên tiếp

        // Tải exchangeInfo
        try {
            await getExchangeInfo();
            if (!exchangeInfoCache) {
                throw new Error('ExchangeInfo rỗng sau khi tải.');
            }
        } catch (error) {
            addLog(`Lỗi khi tải exchangeInfo lúc khởi động: ${error.msg || error.message}.`);
            throw new CriticalApiError(`Không thể tải exchangeInfo.`, error.code || 'EXCHANGE_INFO_FAILED');
        }
        
        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Vốn ban đầu cho mỗi lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);

        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT'; // Đặt hướng mặc định khi khởi động

        // Kiểm tra và xử lý vị thế đang mở từ phiên trước (nếu có)
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const existingPosition = positions.find(p => p.symbol === TARGET_COIN_SYMBOL && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (existingPosition) {
            const side = parseFloat(existingPosition.positionAmt) > 0 ? 'LONG' : 'SHORT';
            addLog(`Tìm thấy vị thế đang mở cho ${TARGET_COIN_SYMBOL}: ${existingPosition.positionAmt} ${side} @ ${existingPosition.entryPrice}.`);
            currentOpenPosition = {
                symbol: TARGET_COIN_SYMBOL,
                quantity: Math.abs(parseFloat(existingPosition.positionAmt)),
                entryPrice: parseFloat(existingPosition.entryPrice),
                initialTPPrice: 0, // Sẽ không sử dụng nếu vị thế đã mở từ trước
                initialSLPrice: 0, // Sẽ không sử dụng nếu vị thế đã mở từ trước
                initialMargin: currentInvestmentAmount, // Giả định vốn ban đầu cho vị thế này
                openTime: new Date(parseFloat(existingPosition.updateTime)),
                pricePrecision: exchangeInfoCache[TARGET_COIN_SYMBOL]?.pricePrecision || 8,
                side: side
            };
            addLog(`Tiếp tục quản lý vị thế đang mở.`);
            // Bắt đầu interval kiểm tra vị thế ngay lập tức
            if(!positionCheckInterval) { 
                positionCheckInterval = setInterval(async () => {
                    if (botRunning && currentOpenPosition) { 
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
                }, 300); 
            }
        } else {
            addLog(`Không tìm thấy vị thế mở nào. Bắt đầu chu kỳ tìm kiếm lệnh mới.`);
            scheduleNextMainCycle(); // Bắt đầu chu kỳ chính để mở lệnh mới
        }

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        const errorCode = error.code || 'UNKNOWN';
        addLog(`[Lỗi khởi động bot] ${errorMsg}`); 
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.'); 
       
        stopBotLogicInternal(); // Dừng bot ngay lập tức
        if (error instanceof CriticalApiError && !retryBotTimeout) { // Chỉ retry nếu là CriticalApiError và chưa có lịch retry
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
    clearTimeout(nextScheduledCycleTimeout); // Hủy lịch trình chu kỳ chính
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval); // Hủy kiểm tra vị thế định kỳ
        positionCheckInterval = null;
    }
    consecutiveApiErrors = 0; // Reset lỗi API
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        addLog('Hủy lịch tự động khởi động lại bot.'); 
    }
    addLog('--- Bot đã dừng ---');
    botStartTime = null;
    currentOpenPosition = null; // Đảm bảo reset trạng thái
    return 'Bot đã dừng.';
}

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();
app.use(express.json()); // Để parse JSON trong body của request POST

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi đọc log file:', err); 
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}. Đảm bảo PM2 đã tạo log và đường dẫn đúng.`); 
            }
            return res.status(500).send('Lỗi đọc log file'); 
        }
        // Xóa các mã màu ANSI escape codes
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
        let detailedStatus = {
            botRunning: botRunning,
            pm2Status: 'offline',
            pm2Restarts: 0,
            uptime: 'N/A',
            currentInvestment: currentInvestmentAmount,
            consecutiveLosses: consecutiveLossCount,
            nextTradeDirection: nextTradeDirection,
            currentOpenPosition: currentOpenPosition ? {
                symbol: currentOpenPosition.symbol,
                side: currentOpenPosition.side,
                quantity: currentOpenPosition.quantity,
                entryPrice: currentOpenPosition.entryPrice.toFixed(currentOpenPosition.pricePrecision),
                openTime: formatTimeUTC7(currentOpenPosition.openTime)
            } : null,
            totalProfit: totalProfit.toFixed(2),
            totalLoss: totalLoss.toFixed(2),
            netPNL: netPNL.toFixed(2)
        };


        if (botProcess) {
            detailedStatus.pm2Status = botProcess.pm2_env.status;
            detailedStatus.pm2Restarts = botProcess.pm2_env.restart_time;
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                    detailedStatus.uptime = `${uptimeMinutes} phút`;
                }
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`; 
        }
        res.json({summary: statusMessage, details: detailedStatus});
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error); 
        res.status(500).json({summary: `Bot: Lỗi lấy trạng thái. (${error.message})`, details: {}}); 
    }
});

// Endpoint để cấu hình các tham số từ frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinSymbol, initialAmount, applyDoubleStrategy } = req.body;

    // Chỉ cập nhật nếu giá trị được cung cấp và hợp lệ
    if (apiKey) API_KEY = apiKey.trim();
    if (secretKey) SECRET_KEY = secretKey.trim();
    if (coinSymbol) TARGET_COIN_SYMBOL = coinSymbol.trim().toUpperCase(); 
    if (!isNaN(parseFloat(initialAmount))) INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount);
    APPLY_DOUBLE_STRATEGY = !!applyDoubleStrategy; 

    // Reset trạng thái bot khi cấu hình lại
    currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
    consecutiveLossCount = 0; 
    nextTradeDirection = 'SHORT'; 

    addLog(`Đã cập nhật cấu hình:`);
    addLog(`  API Key: ${API_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Secret Key: ${SECRET_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Đồng coin: ${TARGET_COIN_SYMBOL}`);
    addLog(`  Số vốn ban đầu: ${INITIAL_INVESTMENT_AMOUNT} USDT`);
    addLog(`  Chiến lược x2 vốn: ${APPLY_DOUBLE_STRATEGY ? 'Bật' : 'Tắt'}`);
    
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
