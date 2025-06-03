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
let nextScheduledCycleTimeout = null; 
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null; 

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0; // Đếm số lỗi API liên tiếp
const MAX_CONSECUTIVE_API_ERRORS = 5; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot
const ERROR_RETRY_DELAY_MS = 1000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 60 giây)

// Cache các thông điệp log để tránh spam quá nhiều dòng giống nhau liên tiếp
const logCounts = {}; // { messageHash: { count: number, lastLoggedTime: Date } }
const LOG_COOLDOWN_MS = 1000; // 5 giây cooldown cho các log không quan trọng lặp lại

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
// SỐ TIỀN USDT CỐ ĐỊNH BAN ĐẦU SẼ DÙNG CHO MỖI LỆNH ĐẦU TƯ.
const INITIAL_INVESTMENT_AMOUNT = 0.08; // Ví dụ: 5 USDT

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.50; // 50% lãi
const STOP_LOSS_PERCENTAGE_MAIN = 0.18;   // 18% lỗ

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

// Thời gian tối đa giữ một vị thế (ví dụ: 180 giây = 3 phút)
const MAX_POSITION_LIFETIME_SECONDS = 9999999999999999999999999999; 

// THAY ĐỔI MỚI: Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay
const RETRY_CHECK_POSITION_ATTEMPTS = 0; // 6 lần
const RETRY_CHECK_POSITION_DELAY_MS = 00000; // 30 giây

// Biến theo dõi vốn hiện tại cho lệnh
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
// Biến theo dõi số lần lỗ liên tiếp
let consecutiveLossCount = 0;
// Biến theo dõi hướng lệnh tiếp theo (SHORT là mặc định ban đầu)
let nextTradeDirection = 'SHORT'; 

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 3333; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log';
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'bot_bina';

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
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
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
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`Hủy lệnh mở cho ${symbol}...`); 
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`Đã hủy lệnh mở cho ${symbol}.`); 
        return true;
    } catch (error) {
        if (error.code === -2011 && error.msg === 'Unknown order sent.') {
            addLog(`Không có lệnh mở cho ${symbol}.`); 
            return true;
        }
        addLog(`Lỗi hủy lệnh mở cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return false;
    }
}

// Hàm đóng lệnh Long/Short
async function closePosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) {
        addLog(`Đang đóng lệnh. Bỏ qua yêu cầu mới cho ${symbol}.`); 
        return; 
    }
    isClosingPosition = true;

    // Lấy thông tin vị thế hiện tại để xác định loại lệnh đóng
    const currentPositionSide = currentOpenPosition?.side; // Lấy từ currentOpenPosition

    addLog(`Đóng lệnh ${currentPositionSide || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantityToClose}.`); 
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`); 
            isClosingPosition = false;
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

            // Xác định 'side' để đóng vị thế hiện tại
            const closeSide = (parseFloat(currentPositionOnBinance.positionAmt) < 0) ? 'BUY' : 'SELL'; // BUY để đóng SHORT, SELL để đóng LONG

            addLog(`Gửi lệnh đóng ${currentPositionSide}: ${symbol}, ${closeSide}, MARKET, Qty: ${adjustedActualQuantity}`); 

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: 'true'
            });

            addLog(`Đã gửi lệnh đóng ${currentPositionSide} ${symbol}. Lý do: ${reason}.`); 
        }
        
        // --- Xử lý logic reset vốn/lượt lỗ và xác định hướng lệnh tiếp theo ---
        if (reason.includes('TP')) { // Vị thế đóng do đạt TP
            consecutiveLossCount = 0; // Reset số lần lỗ liên tiếp
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu
            nextTradeDirection = currentPositionSide; // Giữ nguyên hướng lệnh
            addLog(`Đã đạt TP. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
        } else if (reason.includes('SL') || reason.includes('Hết thời gian')) { // Vị thế đóng do chạm SL hoặc hết thời gian
            consecutiveLossCount++; // Tăng số lần lỗ liên tiếp
            addLog(`Đã chạm SL hoặc hết thời gian. Số lần lỗ liên tiếp: ${consecutiveLossCount}.`);
            if (consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu sau 5 lần lỗ
                consecutiveLossCount = 0;
                addLog(`Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0.`);
            } else {
                currentInvestmentAmount *= 2; // Gấp đôi vốn cho lệnh tiếp theo
                addLog(`Gấp đôi vốn cho lệnh tiếp theo: ${currentInvestmentAmount} USDT.`);
            }
            // Đảo ngược hướng lệnh
            nextTradeDirection = (currentPositionSide === 'LONG' ? 'SHORT' : 'LONG'); 
            addLog(`Lệnh tiếp theo: ${nextTradeDirection}.`);
        } else {
            // Các lý do đóng khác (ví dụ: đóng thủ công, lỗi không rõ, không đủ số dư)
            // Giả định là một trường hợp cần reset trạng thái về ban đầu
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            nextTradeDirection = 'SHORT'; // Về mặc định SHORT nếu không rõ lý do
            addLog(`Lệnh đóng do lý do đặc biệt (${reason}). Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
        }
        // --- Kết thúc xử lý logic ---

        currentOpenPosition = null;
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval); 
            positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol);
        await checkAndHandleRemainingPosition(symbol); 
        if(botRunning) scheduleNextMainCycle();
        isClosingPosition = false;

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false;
    }
}

// Hàm kiểm tra và xử lý vị thế còn sót lại
async function checkAndHandleRemainingPosition(symbol, attempt = 1) {
    if (attempt > RETRY_CHECK_POSITION_ATTEMPTS) {
        addLog(`Đã thử ${RETRY_CHECK_POSITION_ATTEMPTS} lần cho ${symbol} nhưng vẫn còn vị thế. Kiểm tra thủ công!`); 
        // Trong trường hợp vị thế vẫn còn sót sau nhiều lần thử, coi như lỗi và reset vốn
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT'; // Về mặc định SHORT
        addLog(`Vị thế vẫn còn sót sau nhiều lần thử. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
        return;
    }

    addLog(`Kiểm tra vị thế còn sót cho ${symbol} (Lần ${attempt}/${RETRY_CHECK_POSITION_ATTEMPTS})...`); 

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const currentPrice = await getCurrentPrice(symbol);
            const positionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';

            addLog(`Vị thế ${symbol} còn sót: ${currentPositionAmount} (${positionSide}) @ ${currentPrice}. Đang xử lý...`); 

            if (currentOpenPosition && currentOpenPosition.symbol === symbol && currentOpenPosition.side === positionSide) {
                addLog(`Vị thế còn sót. Đặt lại TP/SL cho ${symbol}.`); 
                const { initialSLPrice, initialTPPrice } = currentOpenPosition;
                const symbolInfo = exchangeInfoCache[symbol];
                const quantityPrecision = symbolInfo.quantityPrecision;
                const pricePrecision = symbolInfo.pricePrecision;

                const actualQuantity = Math.abs(currentPositionAmount);
                const adjustedActualQuantity = parseFloat(actualQuantity.toFixed(quantityPrecision));

                const slOrderSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';
                const tpOrderSide = (positionSide === 'LONG') ? 'SELL' : 'BUY';

                try {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: symbol,
                        side: slOrderSide, 
                        type: 'STOP_MARKET', 
                        quantity: adjustedActualQuantity, 
                        stopPrice: initialSLPrice, 
                        closePosition: 'true', 
                        newOrderRespType: 'FULL'
                    });
                    addLog(`Đặt lại SL cho ${symbol} @ ${initialSLPrice.toFixed(pricePrecision)}.`); 
                } catch (slError) {
                    addLog(`Lỗi đặt lại SL ${symbol}: ${slError.msg || slError.message}.`); 
                    if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                        addLog(`SL kích hoạt cho ${symbol}. Đóng vị thế.`); 
                        await closePosition(symbol, actualQuantity, 'SL kích hoạt (sót)');
                        return;
                    }
                }

                try {
                    await callSignedAPI('/fapi/v1/order', 'POST', {
                        symbol: symbol,
                        side: tpOrderSide, 
                        type: 'TAKE_PROFIT_MARKET', 
                        quantity: adjustedActualQuantity, 
                        stopPrice: initialTPPrice, 
                        closePosition: 'true', 
                        newOrderRespType: 'FULL'
                    });
                    addLog(`Đặt lại TP cho ${symbol} @ ${initialTPPrice.toFixed(pricePrecision)}.`); 
                } catch (tpError) {
                    addLog(`Lỗi đặt lại TP ${symbol}: ${tpError.msg || tpError.message}.`); 
                    if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                        addLog(`TP kích hoạt cho ${symbol}. Đóng vị thế.`); 
                        await closePosition(symbol, actualQuantity, 'TP kích hoạt (sót)');
                        return;
                    }
                }
                
                // Kiểm tra lại giá hiện tại so với SL/TP nếu lệnh tái tạo không thành công
                const priceTriggeredSL = (positionSide === 'SHORT' && currentPrice >= initialSLPrice) || (positionSide === 'LONG' && currentPrice <= initialSLPrice);
                const priceTriggeredTP = (positionSide === 'SHORT' && currentPrice <= initialTPPrice) || (positionSide === 'LONG' && currentPrice >= initialTPPrice);

                if (priceTriggeredSL) {
                    addLog(`Giá ${symbol} (${currentPrice}) vượt SL (${initialSLPrice}). Đóng vị thế.`); 
                    await closePosition(symbol, actualQuantity, 'Giá vượt SL');
                    return;
                }
                if (priceTriggeredTP) {
                    addLog(`Giá ${symbol} (${currentPrice}) vượt TP (${initialTPPrice}). Đóng vị thế.`); 
                    await closePosition(symbol, actualQuantity, 'Giá vượt TP');
                    return;
                }
            } else {
                addLog(`currentOpenPosition null hoặc không khớp nhưng vẫn còn vị thế sót cho ${symbol}. Đóng ngay lập tức.`); 
                // Cố gắng đóng vị thế sót nếu không có currentOpenPosition khớp
                // Giả định nó là một SHORT nếu positionAmt âm, LONG nếu dương
                const estimatedSide = currentPositionAmount < 0 ? 'SHORT' : 'LONG';
                currentOpenPosition = {
                    symbol: symbol,
                    quantity: Math.abs(currentPositionAmount),
                    entryPrice: parseFloat(remainingPosition.entryPrice),
                    initialTPPrice: 0, // Giá trị mặc định, không biết TP/SL ban đầu
                    initialSLPrice: 0, // Giá trị mặc định
                    initialMargin: 0, // Giá trị mặc định
                    openTime: new Date(parseFloat(remainingPosition.updateTime)), // Thời gian mở ước tính
                    pricePrecision: symbolInfo.pricePrecision,
                    side: estimatedSide
                };
                await closePosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót không rõ');
                return;
            }
            
            // Nếu vẫn còn vị thế sau khi thử đặt lại TP/SL, thử lại sau một khoảng trễ
            setTimeout(() => checkAndHandleRemainingPosition(symbol, attempt + 1), RETRY_CHECK_POSITION_DELAY_MS);

        } else {
            addLog(`Đã xác nhận không còn vị thế ${symbol}.`); 
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`); 
        setTimeout(() => checkAndHandleRemainingPosition(symbol, attempt + 1), RETRY_CHECK_POSITION_DELAY_MS);
    }
}

// Hàm mở lệnh (Long hoặc Short)
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (currentOpenPosition) {
        addLog(`Đã có vị thế mở (${currentOpenPosition.symbol}). Bỏ qua mở lệnh mới cho ${symbol}.`); 
        if(botRunning) scheduleNextMainCycle(); 
        return;
    }

    addLog(`Mở ${tradeDirection} ${symbol}.`); 
    addLog(`Mở lệnh với số vốn: ${currentInvestmentAmount} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        addLog(`Giá ${symbol}: ${currentPrice.toFixed(pricePrecision)}`); 

        const capitalToUse = currentInvestmentAmount; 

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`); 
            // Reset về lệnh ban đầu khi không đủ số dư
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            nextTradeDirection = 'SHORT'; // Nếu không đủ tiền, về mặc định SHORT
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice; 
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty) {
            addLog(`Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) cho ${symbol}. Hủy.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        if (quantity <= 0) {
            addLog(`Qty cho ${symbol} là ${quantity}. Không hợp lệ. Hủy.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' 
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice); 
        const openTime = new Date();
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`Đã mở ${tradeDirection} ${symbol} lúc ${formattedOpenTime}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Ký quỹ: ${capitalToUse.toFixed(2)} USDT | Qty: ${quantity} ${symbol} | Giá vào: ${entryPrice.toFixed(pricePrecision)}`); 

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        if (tradeDirection === 'LONG') {
            // Đối với lệnh LONG: SL dưới giá vào, TP trên giá vào
            slPrice = entryPrice * (1 - STOP_LOSS_PERCENTAGE_MAIN);
            tpPrice = entryPrice * (1 + TAKE_PROFIT_PERCENTAGE_MAIN);
            slOrderSide = 'SELL'; // Bán để đóng LONG
            tpOrderSide = 'SELL'; // Bán để đóng LONG

            // Làm tròn giá: SL LONG (làm tròn lên), TP LONG (làm tròn xuống)
            slPrice = Math.ceil(slPrice / tickSize) * tickSize; 
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize; 
        } else { // SHORT
            // Đối với lệnh SHORT: SL trên giá vào, TP dưới giá vào
            slPrice = entryPrice * (1 + STOP_LOSS_PERCENTAGE_MAIN);
            tpPrice = entryPrice * (1 - TAKE_PROFIT_PERCENTAGE_MAIN);
            slOrderSide = 'BUY'; // Mua để đóng SHORT
            tpOrderSide = 'BUY'; // Mua để đóng SHORT

            // Làm tròn giá: SL SHORT (làm tròn xuống), TP SHORT (làm tròn lên)
            slPrice = Math.floor(slPrice / tickSize) * tickSize; 
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize; 
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`); 

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: slOrderSide, 
                type: 'STOP_MARKET', 
                quantity: quantity, 
                stopPrice: slPrice, 
                closePosition: 'true', 
                newOrderRespType: 'FULL'
            });
            addLog(`Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`); 
        } catch (slError) {
            addLog(`Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}.`); 
            // Nếu đặt SL thất bại, có thể giá đã vượt, đóng lệnh ngay
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`SL kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, quantity, 'SL kích hoạt ngay');
                return;
            }
        }

        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: tpOrderSide, 
                type: 'TAKE_PROFIT_MARKET', 
                quantity: quantity, 
                stopPrice: tpPrice, 
                closePosition: 'true', 
                newOrderRespType: 'FULL'
            });
            addLog(`Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`); 
        } catch (tpError) {
            addLog(`Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}.`); 
            // Nếu đặt TP thất bại, có thể giá đã vượt, đóng lệnh ngay
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, quantity, 'TP kích hoạt ngay');
                return;
            }
        }

        currentOpenPosition = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            initialTPPrice: tpPrice, 
            initialSLPrice: slPrice, 
            initialMargin: capitalToUse, // Vốn thực tế dùng cho lệnh này
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection // Lưu hướng lệnh (LONG/SHORT)
        };

        if(!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) { 
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`); 
                    }
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval); 
                    positionCheckInterval = null;
                }
            }, 300); // Check more frequently since delays are removed
        }

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`); 
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
            if(botRunning) scheduleNextMainCycle(); 
        }
        return;
    }

    const { symbol, quantity, openTime, initialTPPrice, initialSLPrice, side } = currentOpenPosition; 

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        // Kiểm tra quá hạn vị thế
        if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`Vị thế ${symbol} quá hạn (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`); 
            await closePosition(symbol, quantity, 'Hết thời gian');
            return; 
        }
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        
        // Nếu vị thế không còn trên sàn Binance
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            // Cố gắng suy luận lý do đóng từ các giao dịch gần đây nếu có thể
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, limit: 10 }); 
            let closeReason = "đã đóng trên sàn"; 

            if (recentTrades.length > 0) {
                const latestTrade = recentTrades.find(t => 
                    (side === 'LONG' && t.side === 'SELL' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001) ||
                    (side === 'SHORT' && t.side === 'BUY' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001)
                );

                if (latestTrade) {
                    const priceDiffTP = Math.abs(latestTrade.price - initialTPPrice);
                    const priceDiffSL = Math.abs(latestTrade.price - initialSLPrice);
                    const tickSize = exchangeInfoCache[symbol].tickSize;

                    if (priceDiffTP <= tickSize * 2) { 
                        closeReason = "TP khớp";
                    } else if (priceDiffSL <= tickSize * 2) { 
                        closeReason = "SL khớp";
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

    addLog('Quét cơ hội mở lệnh...'); 
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        if (availableBalance < currentInvestmentAmount) {
            addLog(`Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh (${currentInvestmentAmount.toFixed(2)} USDT). Trở về lệnh ban đầu.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            nextTradeDirection = 'SHORT'; 
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
            scheduleNextMainCycle();
            return;
        }
        
        // Removed funding rate logic, just get a list of common USDT pairs
        const commonUSDTMarkets = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'ADAUSDT', 'DOGEUSDT', 'DOTUSDT', 'LINKUSDT', 'LTCUSDT'];
        let eligibleSymbols = [];

        for (const symbol of commonUSDTMarkets) {
            const symbolDetails = await getSymbolDetails(symbol);
            if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
                const currentPrice = await getCurrentPrice(symbol);
                if (currentPrice === null) {
                    addLog(`Lỗi lấy giá cho ${symbol}. Bỏ qua.`); 
                    continue;
                }
                
                let estimatedQuantity = (currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
                estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                const currentNotional = estimatedQuantity * currentPrice;

                if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                    eligibleSymbols.push({
                        symbol: symbol,
                        maxLeverage: symbolDetails.maxLeverage 
                    });
                } else {
                    addLog(`${symbol}: KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh.`); 
                }
            } else {
                addLog(`${symbol}: Không có đòn bẩy hợp lệ. Bỏ qua.`); 
            }
        }

        if (eligibleSymbols.length > 0) {
            // For simplicity, just pick the first eligible symbol to try and open
            const selectedCandidateToOpen = eligibleSymbols[0];

            addLog(`\nChọn: ${selectedCandidateToOpen.symbol}`); 
            addLog(`  + Đòn bẩy: ${selectedCandidateToOpen.maxLeverage}x | Vốn: ${currentInvestmentAmount.toFixed(2)} USDT`); 
            addLog(`Mở lệnh ${nextTradeDirection} ngay lập tức.`); 
            
            // Execute open position immediately
            await openPosition(selectedCandidateToOpen.symbol, nextTradeDirection, availableBalance, selectedCandidateToOpen.maxLeverage);

        } else { 
            addLog(`Không tìm thấy cơ hội mở lệnh ${nextTradeDirection}.`); 
            if(botRunning) scheduleNextMainCycle();
        }
    } catch (error) {
        addLog('Lỗi trong tìm kiếm cơ hội: ' + (error.msg || error.message));
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`); 
            stopBotLogicInternal();
            retryBotTimeout = setTimeout(async () => {
                addLog('Thử khởi động lại bot...'); 
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        } else {
            if(botRunning) scheduleNextMainCycle(); 
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Không lên lịch chu kỳ mới.'); 
        clearTimeout(nextScheduledCycleTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('Có vị thế mở. Chờ đóng vị thế hiện tại.'); 
        return; 
    }

    clearTimeout(nextScheduledCycleTimeout);

    // With delays removed, we simply schedule the next run after a short pause
    // to prevent continuous rapid calls if no position is found.
    const NEXT_CYCLE_DELAY_MS = 5000; // e.g., wait 5 seconds before checking again
    addLog(`Bot sẽ quét lại sau ${NEXT_CYCLE_DELAY_MS / 1000} giây.`); 

    nextScheduledCycleTimeout = setTimeout(async () => {
        if(botRunning) {
            await runTradingLogic();
        } else {
            addLog('Bot dừng khi chờ. Không tiếp tục chu kỳ.'); 
        }
    }, NEXT_CYCLE_DELAY_MS);
}


// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đang chạy.'); 
        return 'Bot đang chạy.';
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
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`); 
        
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

        // Khởi tạo lại các biến trạng thái khi bot khởi động
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT'; 

        scheduleNextMainCycle();

        // Bắt đầu interval kiểm tra vị thế nếu chưa có
        if (!positionCheckInterval) { 
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

app.get('/', (req, res) => {
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
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`; 
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error); 
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error})`); 
    }
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
