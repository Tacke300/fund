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
const ERROR_RETRY_DELAY_MS = 1000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 1 giây)

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
let INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 10 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'ETHUSDT'; // Mặc định NEIROUSDT (sẽ được cập nhật từ UI)
let APPLY_DOUBLE_STRATEGY = false; // Mặc định false (sẽ được cập nhật từ UI)

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.60; // 50% lãi trên VỐN
const STOP_LOSS_PERCENTAGE_MAIN = 0.175;   // 18% lỗ trên VỐN

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

// THAY ĐỔI MỚI: Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay (đã loại bỏ delay)
const RETRY_CHECK_POSITION_ATTEMPTS = 0; 
const RETRY_CHECK_POSITION_DELAY_MS = 0; 

// Biến theo dõi vốn hiện tại cho lệnh
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
// Biến theo dõi số lần lỗ liên tiếp
let consecutiveLossCount = 0;
// Biến theo dõi hướng lệnh tiếp theo (SHORT là mặc định ban đầu)
let nextTradeDirection = 'SHORT'; 

// Tổng lời/lỗ để hiển thị
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;


// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1997; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log'; // Cần điều chỉnh nếu dùng PM2
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = '1998'; // Cần điều chỉnh nếu dùng PM2

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

// Hủy tất cả các lệnh mở cho một symbol cụ thể.
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`Hủy tất cả lệnh chờ cho ${symbol}...`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
        return true;
    } catch (error) {
        addLog(`Lỗi hủy lệnh chờ cho ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}


/**
 * Hàm đóng vị thế hiện tại và cập nhật trạng thái bot.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng vị thế cần đóng.
 * @param {string} reason - Lý do đóng vị thế (ví dụ: "TP", "SL", "Đóng thủ công").
 */
async function closePosition(symbol, quantity, reason) {
    if (isClosingPosition) {
        addLog(`Đang trong quá trình đóng lệnh. Bỏ qua lệnh đóng ${symbol} mới.`);
        return;
    }
    isClosingPosition = true;
    
    // Lấy thông tin vị thế đóng
    const positionSideBeforeClose = currentOpenPosition?.side; // Lấy hướng trước khi reset currentOpenPosition

    addLog(`Đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantity}.`); 
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

            addLog(`Gửi lệnh đóng ${positionSideBeforeClose}: ${symbol}, ${closeSide}, MARKET, Qty: ${adjustedActualQuantity}`); 

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: 'true'
            });

            addLog(`Đã gửi lệnh đóng ${positionSideBeforeClose} ${symbol}. Lý do: ${reason}.`); 
        }
        
        // --- Xử lý logic reset vốn/lượt lỗ và xác định hướng lệnh tiếp theo ---
        if (currentOpenPosition) { // Đảm bảo currentOpenPosition còn giá trị trước khi tính PNL
             const entryPrice = currentOpenPosition.entryPrice;
             const closePrice = await getCurrentPrice(symbol);
             const pnl = (currentOpenPosition.side === 'LONG')
                 ? (closePrice - entryPrice) * currentOpenPosition.quantity
                 : (entryPrice - closePrice) * currentOpenPosition.quantity;

             // Cập nhật tổng lời/lỗ
             if (pnl > 0) {
                 totalProfit += pnl;
             } else {
                 totalLoss += Math.abs(pnl);
             }
             netPNL = totalProfit - totalLoss;

             // Log PNL
             addLog([
                 `🔴 Đã đóng ${currentOpenPosition.side} ${symbol}`,
                 `├─ Lý do: ${reason}`,
                 `├─ PNL: ${pnl.toFixed(2)} USDT`,
                 `├─ Tổng Lời: ${totalProfit.toFixed(2)} USDT`,
                 `├─ Tổng Lỗ: ${totalLoss.toFixed(2)} USDT`,
                 `└─ PNL Ròng: ${netPNL.toFixed(2)} USDT`
             ].join('\n'));
         }


        if (reason.includes('TP')) { // Vị thế đóng do đạt TP
            consecutiveLossCount = 0; // Reset số lần lỗ liên tiếp
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu
            nextTradeDirection = positionSideBeforeClose; // Giữ nguyên hướng lệnh
            addLog(`Đã đạt TP. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
        } else if (reason.includes('SL') || reason.includes('Hết thời gian')) { // Vị thế đóng do chạm SL hoặc hết thời gian
            if (APPLY_DOUBLE_STRATEGY) {
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
            } else {
                 addLog(`Đã chạm SL hoặc hết thời gian. Không áp dụng chiến lược x2 vốn.`);
                 currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Giữ nguyên vốn ban đầu
                 consecutiveLossCount = 0; // Reset số lượt lỗ
            }
            // Đảo ngược hướng lệnh dựa trên hướng lệnh đã bị đóng
            nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); 
            addLog(`Lệnh tiếp theo: ${nextTradeDirection}.`);
        } else {
            // Các lý do đóng khác (ví dụ: đóng thủ công, lỗi không rõ, không đủ số dư)
            // Giả định là một trường hợp cần reset trạng thái về ban đầu
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); // Vẫn đảo chiều nếu lý do không rõ là do lỗi
            addLog(`Lệnh đóng do lý do đặc biệt (${reason}). Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${nextTradeDirection}.`);
        }
        // --- Kết thúc xử lý logic ---

        currentOpenPosition = null; // Chỉ reset sau khi đã xử lý logic nextTradeDirection
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval); 
            positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol);
        await checkAndHandleRemainingPosition(symbol); 
        if(botRunning) scheduleNextMainCycle(); // Kích hoạt chu kỳ chính ngay lập tức để mở lệnh mới
        isClosingPosition = false;

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false;
    }
}

// Hàm kiểm tra và xử lý vị thế còn sót lại (đã bỏ delay và retry)
async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Kiểm tra vị thế còn sót cho ${symbol}...`); 

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const currentPrice = await getCurrentPrice(symbol);
            const positionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';

            addLog(`Vị thế ${symbol} còn sót: ${currentPositionAmount} (${positionSide}) @ ${currentPrice}. Cố gắng đóng lại.`); 

            // Cố gắng đóng vị thế sót nếu còn
            const estimatedSide = currentPositionAmount < 0 ? 'SHORT' : 'LONG';
            currentOpenPosition = { // Tạo tạm currentOpenPosition để hàm closePosition hoạt động
                symbol: symbol,
                quantity: Math.abs(currentPositionAmount),
                entryPrice: parseFloat(remainingPosition.entryPrice),
                initialTPPrice: 0, 
                initialSLPrice: 0, 
                initialMargin: 0, 
                openTime: new Date(parseFloat(remainingPosition.updateTime)), 
                pricePrecision: (exchangeInfoCache[symbol] ? exchangeInfoCache[symbol].pricePrecision : 8), // Mặc định 8 nếu không tìm thấy
                side: estimatedSide
            };
            await closePosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót');
        } else {
            addLog(`Đã xác nhận không còn vị thế ${symbol}.`); 
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`); 
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

        const currentPrice = await getCurrentPrice(symbol); // Giá thị trường tại thời điểm gửi lệnh
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`); 
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`); 

        const capitalToUse = currentInvestmentAmount; 

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`); 
            // Reset về lệnh ban đầu khi không đủ số dư
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            addLog(`Số dư không đủ. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${nextTradeDirection}.`);
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

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        // Định nghĩa khoảng cách tối thiểu giữa giá vào và TP/SL để tránh lỗi Binance
        // Có thể điều chỉnh con số này tùy theo cặp coin và tickSize
        const MIN_PRICE_DISTANCE_FROM_ENTRY = tickSize * 5; // Ví dụ: 5 tickSize
        const MIN_TP_SL_DISTANCE = tickSize * 2; // Khoảng cách tối thiểu giữa TP và SL

        if (tradeDirection === 'LONG') {
            // Tính toán ban đầu
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            slOrderSide = 'SELL'; 
            tpOrderSide = 'SELL'; 

            // Làm tròn cho LONG:
            // TP: Cần LỚN HƠN entryPrice. Làm tròn xuống để đảm bảo không bị vượt quá TP mong muốn nhiều.
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize;
            // SL: Cần NHỎ HƠN entryPrice. Làm tròn LÊN để đảm bảo không bị vượt quá SL mong muốn nhiều.
            slPrice = Math.ceil(slPrice / tickSize) * tickSize;

            // Đảm bảo TP > entryPrice + MIN_PRICE_DISTANCE_FROM_ENTRY
            if (tpPrice <= entryPrice + MIN_PRICE_DISTANCE_FROM_ENTRY) {
                tpPrice = Math.ceil((entryPrice + MIN_PRICE_DISTANCE_FROM_ENTRY) / tickSize) * tickSize;
            }
            // Đảm bảo SL < entryPrice - MIN_PRICE_DISTANCE_FROM_ENTRY
            if (slPrice >= entryPrice - MIN_PRICE_DISTANCE_FROM_ENTRY) {
                slPrice = Math.floor((entryPrice - MIN_PRICE_DISTANCE_FROM_ENTRY) / tickSize) * tickSize;
            }
            // Đảm bảo TP > SL (cho lệnh LONG)
            // Cần + MIN_TP_SL_DISTANCE để đảm bảo TP luôn lớn hơn SL một khoảng tối thiểu
            if (tpPrice <= slPrice + MIN_TP_SL_DISTANCE) { 
                tpPrice = Math.ceil((slPrice + MIN_TP_SL_DISTANCE) / tickSize) * tickSize;
            }


        } else { // SHORT
            // Tính toán ban đầu
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            slOrderSide = 'BUY'; 
            tpOrderSide = 'BUY'; 

            // Làm tròn cho SHORT:
            // TP: Cần NHỎ HƠN entryPrice. Làm tròn LÊN để đảm bảo không bị vượt quá TP mong muốn nhiều.
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize;
            // SL: Cần LỚN HƠN entryPrice. Làm tròn XUỐNG để đảm bảo không bị vượt quá SL mong muốn nhiều.
            slPrice = Math.floor(slPrice / tickSize) * tickSize;

            // Đảm bảo TP < entryPrice - MIN_PRICE_DISTANCE_FROM_ENTRY
            if (tpPrice >= entryPrice - MIN_PRICE_DISTANCE_FROM_ENTRY) {
                tpPrice = Math.floor((entryPrice - MIN_PRICE_DISTANCE_FROM_ENTRY) / tickSize) * tickSize;
            }
            // Đảm bảo SL > entryPrice + MIN_PRICE_DISTANCE_FROM_ENTRY
            if (slPrice <= entryPrice + MIN_PRICE_DISTANCE_FROM_ENTRY) {
                slPrice = Math.ceil((entryPrice + MIN_PRICE_DISTANCE_FROM_ENTRY) / tickSize) * tickSize;
            }
            // Đảm bảo TP < SL (cho lệnh SHORT)
            // Cần - MIN_TP_SL_DISTANCE để đảm bảo TP luôn nhỏ hơn SL một khoảng tối thiểu
            if (tpPrice >= slPrice - MIN_TP_SL_DISTANCE) { 
                tpPrice = Math.floor((slPrice - MIN_TP_SL_DISTANCE) / tickSize) * tickSize;
            }
        }

        // Làm tròn cuối cùng với pricePrecision
        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`Giá đặt TP: ${tpPrice.toFixed(pricePrecision)}, Giá đặt SL: ${slPrice.toFixed(pricePrecision)}`); 

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
                addLog(`SL kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, 'SL kích hoạt ngay');
                return;
            }
        }

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
                addLog(`TP kích hoạt ngay lập tức cho ${symbol}. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, 'TP kích hoạt ngay');
                return;
            }
        }

        currentOpenPosition = {
            symbol: symbol,
            quantity: actualQuantity, 
            entryPrice: entryPrice,    
            initialTPPrice: tpPrice, // Lưu giá TP đã làm tròn
            initialSLPrice: slPrice, // Lưu giá SL đã làm tròn
            initialMargin: capitalToUse, 
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection 
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
            }, 300); 
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
 * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP)
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

    const { symbol, quantity, initialTPPrice, initialSLPrice, side } = currentOpenPosition; 

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        
        // Nếu vị thế không còn trên sàn Binance
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            // Cố gắng suy luận lý do đóng từ các giao dịch gần đây nếu có thể
            // LƯU Ý: Việc suy luận này chỉ mang tính tương đối.
            // Hệ thống TP/SL của Binance (STOP_MARKET, TAKE_PROFIT_MARKET) là đáng tin cậy nhất.
            // Phần này chủ yếu để log lại lý do đóng cho tiện theo dõi.
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, limit: 10 }); 
            let closeReason = "đã đóng trên sàn"; 

            if (recentTrades.length > 0) {
                const latestTrade = recentTrades.find(t => 
                    (side === 'LONG' && t.side === 'SELL' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001) || // Đã bán để đóng Long
                    (side === 'SHORT' && t.side === 'BUY' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001) // Đã mua để đóng Short
                );

                if (latestTrade) {
                    const tickSize = exchangeInfoCache[symbol].tickSize;
                    const priceDiffTP = Math.abs(parseFloat(latestTrade.price) - initialTPPrice);
                    const priceDiffSL = Math.abs(parseFloat(latestTrade.price) - initialSLPrice);
                    
                    // Khoảng dung sai nhỏ cho việc so sánh giá do làm tròn
                    const tolerance = tickSize * 1.5; 

                    if (priceDiffTP <= tolerance) { 
                        closeReason = "TP khớp";
                    } else if (priceDiffSL <= tolerance) { 
                        closeReason = "SL khớp";
                    }
                    // Có thể thêm kiểm tra nếu trade là do người dùng đóng thủ công
                    if (latestTrade.orderId && latestTrade.orderId === 0) { // orderId = 0 thường là lệnh market thủ công
                         closeReason += " (Thủ công)";
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
            if(botRunning) scheduleNextMainCycle();
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
