import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws'; // Thêm WebSocket

// Lấy __filename và __dirname trong ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH API KEY VÀ SECRET KEY (BAN ĐẦU RỖNG) ---
let API_KEY = '';
let SECRET_KEY = '';

// --- BASE URL CỦA BINANCE FUTURES API ---
const BASE_HOST = 'fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com'; // WebSocket Base URL
const WS_USER_DATA_ENDPOINT = '/ws'; // Endpoint chung cho user data stream

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
const MAX_CONSECUTIVE_API_ERRORS = 3; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot (ĐÃ GIẢM)
const ERROR_RETRY_DELAY_MS = 10000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (10 giây) (ĐÃ TĂNG)

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

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊC (GIÁ TRỊ MẶC ĐỊNH) ---
let INITIAL_INVESTMENT_AMOUNT = 1; // Mặc định 1 USDT (sẽ được cập nhật từ UI)
let TARGET_COIN_SYMBOL = 'ETHUSDT'; // Mặc định ETHUSDT (sẽ được cập nhật từ UI)
let APPLY_DOUBLE_STRATEGY = false; // Mặc định false (sẽ được cập nhật từ UI)

// Cấu hình Take Profit & Stop Loss
const TAKE_PROFIT_PERCENTAGE_MAIN = 5.1; // 155% lãi trên VỐN HIỆN TẠI
const STOP_LOSS_PERCENTAGE_MAIN = 2.4;   // 80% lỗ trên VỐN HIỆN TẠI

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 6;

// Biến theo dõi vốn hiện tại cho lệnh
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
// Biến theo dõi số lần lỗ liên tiếp
let consecutiveLossCount = 0;
// Biến theo dõi hướng lệnh tiếp theo (SHORT là mặc định ban đầu)
let nextTradeDirection = 'SHORT';

// Biến để lưu trữ tổng lời/lỗ
let totalProfit = 0;
let totalLoss = 0;
let netPNL = 0;

// --- BIẾN TRẠNG THÁI WEBSOCKET ---
let marketWs = null; // WebSocket cho giá thị trường (Mark Price)
let userDataWs = null; // WebSocket cho user data (tài khoản)
let listenKey = null; // Key để duy trì User Data Stream
let listenKeyRefreshInterval = null; // Interval để làm mới listenKey
let currentMarketPrice = null; // Cache giá từ WebSocket

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1235; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log'; // Cần điều chỉnh nếu dùng PM2
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'futu'; // Cần điều chỉnh nếu dùng PM2

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
    } else if (method === 'PUT') { // Thêm method PUT
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
        consecutiveApiErrors = 0; // Reset lỗi nếu thành công
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
        } else if (error.code === -1003) { // Đặc biệt xử lý lỗi Rate Limit
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
        consecutiveApiErrors = 0; // Reset lỗi nếu thành công
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        addLog(`Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -1003) { // Đặc biệt xử lý lỗi Rate Limit
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

// Lấy giá hiện tại của một symbol (ĐÃ CHỈNH SỬA: CHỈ DÙNG REST API)
async function getCurrentPrice(symbol) {
    addLog(`Lấy giá ${symbol} từ REST API.`);
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        const price = parseFloat(data.price);
        addLog(`Đã lấy giá ${symbol} từ REST API: ${price}`);
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
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
    } catch (error) {
        addLog(`Lỗi hủy lệnh chờ cho ${symbol}: ${error.msg || error.message}`);
        if (error.code === -2011) { // Lỗi "Unknown order" khi không có lệnh nào để hủy
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
 * @param {number} pnlForClosedTrade - PNL thực tế của giao dịch đã đóng.
 * @param {string} positionSideBeforeClose - Hướng của vị thế trước khi đóng (LONG/SHORT).
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} closedQuantity - Số lượng đã đóng.
 */
async function processTradeResult(pnlForClosedTrade, positionSideBeforeClose, symbol, closedQuantity) {
    addLog(`Đang xử lý kết quả giao dịch ${symbol} (${positionSideBeforeClose}) với PNL: ${pnlForClosedTrade.toFixed(4)}`);

    // Cập nhật tổng lời/lỗ
    if (pnlForClosedTrade > 0.000001) { // PNL dương đáng kể
        totalProfit += pnlForClosedTrade;
    } else if (pnlForClosedTrade < -0.000001) { // PNL âm đáng kể
        totalLoss += Math.abs(pnlForClosedTrade);
    }
    netPNL = totalProfit - totalLoss;

    addLog([
        `🔴 Đã đóng ${positionSideBeforeClose || 'UNKNOWN'} ${symbol}`,
        `├─ PNL: ${pnlForClosedTrade.toFixed(2)} USDT`,
        `├─ Tổng Lời: ${totalProfit.toFixed(2)} USDT`,
        `├─ Tổng Lỗ: ${totalLoss.toFixed(2)} USDT`,
        `└─ PNL Ròng: ${netPNL.toFixed(2)} USDT`
    ].join('\n'));

    // --- BẮT ĐẦU LOGIC ĐIỀU CHỈNH VỐN ---
    if (pnlForClosedTrade > 0.000001) { // PNL dương đáng kể
        nextTradeDirection = positionSideBeforeClose; // Giữ nguyên hướng
        consecutiveLossCount = 0; // Reset chuỗi lỗ
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu
        addLog(`PNL dương (${pnlForClosedTrade.toFixed(4)}). Lệnh tiếp theo: GIỮ NGUYÊN HƯỚNG (${nextTradeDirection}).`);
    } else { // PNL âm hoặc gần bằng 0
        nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); // Đảo chiều
        if (APPLY_DOUBLE_STRATEGY) {
            consecutiveLossCount++;
            addLog(`PNL âm hoặc hòa (${pnlForClosedTrade.toFixed(4)}). Số lần lỗ liên tiếp: ${consecutiveLossCount}.`);
            if (consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Về lại vốn ban đầu sau MAX_CONSECUTIVE_LOSSES lần lỗ
                consecutiveLossCount = 0; // Reset chuỗi lỗ
                addLog(`Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${currentInvestmentAmount} USDT và lượt lỗ về 0.`);
            } else {
                addLog(`[DEBUG] Trước khi nhân đôi: currentInvestmentAmount = ${currentInvestmentAmount}`);
                currentInvestmentAmount *= 1.6; // Gấp đôi vốn cho lệnh tiếp theo
                addLog(`Gấp đôi vốn cho lệnh tiếp theo: ${currentInvestmentAmount} USDT.`);
            }
        } else {
            addLog(`PNL âm hoặc hòa (${pnlForClosedTrade.toFixed(4)}). Không áp dụng chiến lược x2 vốn.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Giữ nguyên vốn ban đầu
            consecutiveLossCount = 0; // Reset chuỗi lỗ
        }
        addLog(`Lệnh tiếp theo: ĐẢO CHIỀU thành (${nextTradeDirection}).`);
    }
    // --- KẾT THÚC LOGIC ĐIỀU CHỈNH VỐN ---

    // Dọn dẹp trạng thái bot sau khi một giao dịch hoàn tất
    currentOpenPosition = null; // Đảm bảo vị thế được reset
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    await cancelOpenOrdersForSymbol(symbol); // Hủy các lệnh chờ cũ (TP/SL)
    await checkAndHandleRemainingPosition(symbol); // Đảm bảo không còn vị thế sót

    // Kích hoạt chu kỳ chính để mở lệnh mới
    if(botRunning) scheduleNextMainCycle();
}

/**
 * Hàm đóng vị thế hiện tại và xử lý logic sau khi đóng.
 * LƯU Ý: Hàm này chỉ gửi lệnh đóng. Logic xử lý PNL và điều chỉnh vốn
 * sẽ nằm trong callback của User Data Stream khi nhận được sự kiện 'ORDER_TRADE_UPDATE'
 * có 'realizedPnl' khác 0.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng của vị thế cần đóng (để tham chiếu).
 * @param {string} reason - Lý do đóng vị thế (ví dụ: "TP khớp", "SL khớp", "Thủ công", "Vị thế sót").
 */
async function closePosition(symbol, quantity, reason) {
    // Đảm bảo chỉ có một lần gọi đóng vị thế được xử lý tại một thời điểm
    if (isClosingPosition) {
        addLog(`Đang trong quá trình đóng vị thế ${symbol}. Bỏ qua yêu cầu đóng mới.`);
        return;
    }
    isClosingPosition = true;

    // Lưu lại các thông tin cần thiết trước khi currentOpenPosition có thể bị xóa
    const positionSideBeforeClose = currentOpenPosition?.side; // Lấy side trước khi currentOpenPosition bị reset
    const initialQuantity = currentOpenPosition?.quantity; // Lấy quantity ban đầu để theo dõi

    addLog(`Đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do: ${reason}).`);

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
            addLog(`${symbol} đã đóng trên sàn hoặc không có vị thế để đóng. Lý do: ${reason}.`);
            // Nếu đã đóng trên sàn, không cần gửi lệnh đóng
            // PNL đã được xử lý bởi User Data Stream hoặc sẽ được xử lý nếu đây là vị thế sót mới được phát hiện.
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));
            const closeSide = (parseFloat(currentPositionOnBinance.positionAmt) < 0) ? 'BUY' : 'SELL';

            if (adjustedActualQuantity <= 0) {
                addLog(`Số lượng đóng (${adjustedActualQuantity}) cho ${symbol} không hợp lệ. Không gửi lệnh đóng.`);
                isClosingPosition = false;
                return;
            }

            addLog(`Gửi lệnh đóng ${positionSideBeforeClose || closeSide}: ${symbol}, ${closeSide}, MARKET, Qty: ${adjustedActualQuantity}`);

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: 'true'
            });

            addLog(`Đã gửi lệnh đóng ${positionSideBeforeClose || closeSide} ${symbol}. Lý do: ${reason}.`);

            // KHÔNG gọi getAndProcessRealizedPnl ở đây. Chờ User Data Stream.
            // Để một khoảng chờ ngắn để lệnh khớp và sự kiện WebSocket được gửi.
            await sleep(1000);

        }

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Lỗi API nghiêm trọng khi cố gắng đóng vị thế. Bot dừng.`);
            stopBotLogicInternal();
        }
    } finally {
        isClosingPosition = false; // Luôn reset biến cờ để cho phép các lệnh đóng tiếp theo (nếu cần)
    }
}


// Hàm kiểm tra và xử lý vị thế còn sót lại
async function checkAndHandleRemainingPosition(symbol, retryCount = 0) {
    const MAX_RETRY_CHECK_POSITION = 3; // Số lần thử lại tối đa để kiểm tra vị thế sót
    const CHECK_POSITION_RETRY_DELAY_MS = 1000; // Độ trễ giữa các lần thử lại (ms) (ĐÃ TĂNG)

    addLog(`Kiểm tra vị thế còn sót cho ${symbol} (Lần ${retryCount + 1}/${MAX_RETRY_CHECK_POSITION + 1})...`);

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const currentPrice = await getCurrentPrice(symbol); // Lấy giá từ REST API
            const positionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';

            addLog(`Vị thế ${symbol} còn sót: ${currentPositionAmount} (${positionSide}) @ ${currentPrice}.`);

            if (retryCount < MAX_RETRY_CHECK_POSITION) {
                addLog(`Vị thế sót vẫn còn. Thử lại sau ${CHECK_POSITION_RETRY_DELAY_MS}ms.`);
                await sleep(CHECK_POSITION_RETRY_DELAY_MS);
                await checkAndHandleRemainingPosition(symbol, retryCount + 1); // Gọi đệ quy để thử lại
            } else {
                addLog(`Đã thử ${MAX_RETRY_CHECK_POSITION + 1} lần, vị thế ${symbol} vẫn còn sót. Cố gắng đóng lại lần cuối.`);
                // Lấy thông tin positionSide từ vị thế sót hiện tại nếu currentOpenPosition đã bị reset
                const sideToClose = currentOpenPosition?.side || positionSide;
                await closePosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót cuối cùng');
            }
        } else {
            addLog(`Đã xác nhận không còn vị thế ${symbol}.`);
        }
    } catch (error) {
        addLog(`Lỗi kiểm tra vị thế sót cho ${symbol}: ${error.code} - ${error.msg || error.message}.`);
        // Không rethrow lỗi ở đây để không làm gián đoạn chu trình chính của bot
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
        await sleep(500); // Thêm độ trễ sau setLeverage

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        // Vị trí quan trọng: Hàm getCurrentPrice ở đây sẽ gọi REST API
        const currentPrice = await getCurrentPrice(symbol); // <--- ĐÂY LÀ CHỖ CHỈ DÙNG REST API
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = currentInvestmentAmount;

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`);
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
            await cancelOpenOrdersForSymbol(symbol);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt)); // Lấy số lượng thực tế của vị thế
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now())); // Thời gian cập nhật vị thế
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`Đã mở ${tradeDirection} ${symbol} lúc ${formattedOpenTime}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x | Vốn: ${capitalToUse.toFixed(2)} USDT | Qty thực tế: ${actualQuantity} ${symbol} | Giá vào thực tế: ${entryPrice.toFixed(pricePrecision)}`);

        // --- Hủy tất cả các lệnh chờ hiện tại (TP/SL) nếu có trước khi đặt lại ---
        await cancelOpenOrdersForSymbol(symbol);
        addLog(`Đã hủy các lệnh chờ cũ (nếu có) cho ${symbol}.`);
        await sleep(500); // Thêm độ trễ sau hủy lệnh

        // --- BẮT ĐẦU TÍNH TOÁN TP/SL THEO % VỐN (dùng giá vào lệnh thực tế và số lượng thực tế) ---
        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_PERCENTAGE_MAIN; // 155% của vốn hiện tại
        const lossLimitUSDT = capitalToUse * STOP_LOSS_PERCENTAGE_MAIN;     // 80% của vốn hiện tại

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        if (tradeDirection === 'LONG') {
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            slOrderSide = 'SELL';
            tpOrderSide = 'SELL';

            slPrice = Math.floor(slPrice / tickSize) * tickSize;
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize;

        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            slOrderSide = 'BUY';
            tpOrderSide = 'BUY';

            slPrice = Math.ceil(slPrice / tickSize) * tickSize;
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize;
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`Giá Entry: ${entryPrice.toFixed(pricePrecision)}`);
        addLog(`TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

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
            await sleep(500);
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
            await sleep(500);
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
            initialTPPrice: tpPrice,
            initialSLPrice: slPrice,
            initialMargin: capitalToUse,
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection
        };

        // Đảm bảo positionCheckInterval chỉ được thiết lập một lần
        if(!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    try {
                        await manageOpenPosition();
                    }
                    catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ: ${error.msg || error.message}.`);
                    }
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 2000); // Tăng interval lên 5 giây
        }

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`);
            stopBotLogicInternal();
        } else {
            addLog(`Đợi 2 giây trước khi lên lịch chu kỳ mới sau lỗi mở lệnh.`);
            await sleep(2000);
            if(botRunning) scheduleNextMainCycle();
        }
    }
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở (chỉ cập nhật PNL chưa hiện thực hóa)
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

    const { symbol, quantity, side } = currentOpenPosition;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`Vị thế ${symbol} đã đóng trên sàn. Cập nhật bot.`);
            // User Data Stream đã xử lý PNL, chỉ cần reset trạng thái bot
            currentOpenPosition = null;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            await cancelOpenOrdersForSymbol(symbol);
            await checkAndHandleRemainingPosition(symbol);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        // Cập nhật PNL chưa hiện thực hóa để hiển thị trên UI
        // Ở đây vẫn có thể dùng WebSocket nếu bạn muốn cập nhật giá nhanh hơn cho mục đích hiển thị UI
        const currentPrice = currentMarketPrice !== null && TARGET_COIN_SYMBOL === symbol ? currentMarketPrice : await getCurrentPrice(symbol); // Lấy giá từ WebSocket HOẶC REST API (fallback)
        if (currentPrice) {
            let unrealizedPnl = 0;
            if (side === 'LONG') {
                unrealizedPnl = (currentPrice - currentOpenPosition.entryPrice) * currentOpenPosition.quantity;
            } else { // SHORT
                unrealizedPnl = (currentOpenPosition.entryPrice - currentPrice) * currentOpenPosition.quantity;
            }
            currentOpenPosition.unrealizedPnl = unrealizedPnl;
            currentOpenPosition.currentPrice = currentPrice;
        }


    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế.`);
             stopBotLogicInternal();
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot (đã bỏ delay)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét.');
        return;
    }

    if (currentOpenPosition) {
        addLog('Có vị thế mở. Bỏ qua quét mới.');
        return;
    }

    clearTimeout(nextScheduledCycleTimeout);

    addLog(`Lên lịch chu kỳ giao dịch tiếp theo sau 5 giây...`);
    nextScheduledCycleTimeout = setTimeout(runTradingLogic, 2000); // Đợi 5 giây
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
        return null; // Trả về null nếu không lấy được
    }
}

async function keepAliveListenKey() {
    if (!listenKey) {
        addLog("Không có listenKey để làm mới.");
        return;
    }
    try {
        await callSignedAPI('/fapi/v1/listenKey', 'PUT', { listenKey: listenKey });
        addLog(`Đã làm mới listenKey.`);
    } catch (error) {
        addLog(`Lỗi khi làm mới listenKey: ${error.msg || error.message}`);
        // Nếu lỗi nghiêm trọng, thử lấy listenKey mới
        if (error instanceof CriticalApiError || error.code === -1000 || error.code === -1125) { // Lỗi Internal error hoặc Bad listenKey
            addLog("Lỗi nghiêm trọng khi làm mới listenKey. Cố gắng lấy listenKey mới.");
            try {
                listenKey = await getListenKey();
                if (listenKey) {
                    setupUserDataStream(listenKey); // Khởi tạo lại stream với key mới
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

    // Sử dụng stream markPrice mỗi 1 giây
    const streamUrl = `${WS_BASE_URL}${WS_USER_DATA_ENDPOINT}/${symbol.toLowerCase()}@markPrice@1s`;

    addLog(`Kết nối Market WebSocket: ${streamUrl}`);
    marketWs = new WebSocket(streamUrl);

    marketWs.onopen = () => {
        addLog(`Market WebSocket cho ${symbol} đã kết nối.`);
    };

    marketWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.e === 'markPriceUpdate') {
                currentMarketPrice = parseFloat(data.p);
                // addLog(`Giá ${symbol} (Mark Price): ${currentMarketPrice}`); // Quá nhiều log, chỉ dùng để debug ban đầu
            }
        } catch (e) {
            addLog(`Lỗi phân tích cú pháp Market WebSocket message: ${e.message}`);
        }
    };

    marketWs.onerror = (error) => {
        addLog(`Market WebSocket lỗi cho ${symbol}: ${error.message}. Đang thử kết nối lại...`);
        // Đặt timeout trước khi cố gắng kết nối lại
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
        // Bắt đầu làm mới listenKey định kỳ (mỗi 30 phút = 1800000ms)
        if (listenKeyRefreshInterval) clearInterval(listenKeyRefreshInterval);
        listenKeyRefreshInterval = setInterval(keepAliveListenKey, 1800000);
    };

    userDataWs.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            // addLog(`User Data WebSocket nhận được: ${JSON.stringify(data)}`); // Rất nhiều log, cẩn thận
            if (data.e === 'ORDER_TRADE_UPDATE') {
                const order = data.o;
                if (order.X === 'FILLED' && parseFloat(order.rp) !== 0) { // Nếu lệnh đã khớp và có realizedPnl khác 0
                    addLog(`Phát hiện lệnh đóng vị thế khớp. Symbol: ${order.s}, Side: ${order.S}, PNL: ${order.rp}`);
                    // Kiểm tra nếu đây là lệnh đóng vị thế đang mở của bot
                    // Có thể thêm kiểm tra order.q khớp với currentOpenPosition.quantity để chắc chắn hơn
                    if (currentOpenPosition && order.s === currentOpenPosition.symbol) {
                        const isClosingLong = currentOpenPosition.side === 'LONG' && order.S === 'SELL';
                        const isClosingShort = currentOpenPosition.side === 'SHORT' && order.S === 'BUY';
                        
                        // Đảm bảo số lượng của lệnh khớp là đủ lớn để đóng vị thế
                        const orderQuantity = parseFloat(order.q);
                        const positionQuantity = currentOpenPosition.quantity;
                        const quantityTolerance = 0.00001; // Sai số nhỏ cho số lượng

                        if ((isClosingLong || isClosingShort) && Math.abs(orderQuantity - positionQuantity) < quantityTolerance) {
                            addLog(`Xử lý PNL từ User Data Stream: ${parseFloat(order.rp)}`);
                            await processTradeResult(parseFloat(order.rp), currentOpenPosition.side, currentOpenPosition.symbol, orderQuantity);
                        } else {
                           addLog(`Sự kiện ORDER_TRADE_UPDATE không khớp với vị thế hiện tại hoặc đã được xử lý.`);
                        }
                    }
                }
            } else if (data.e === 'ACCOUNT_UPDATE') {
                // Xử lý cập nhật số dư hoặc vị thế nếu cần
                // addLog(`Cập nhật tài khoản: ${JSON.stringify(data.a)}`);
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
                    listenKey = await getListenKey(); // Lấy listenKey mới
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
                    listenKey = await getListenKey(); // Lấy listenKey mới
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

    if (currentOpenPosition) {
        addLog(`Đã có vị thế mở (${currentOpenPosition.symbol}). Không mở lệnh mới. Tiếp tục theo dõi.`);
        // Vẫn giữ lại manageOpenPosition trong interval, không gọi trực tiếp ở đây
        // scheduleNextMainCycle(); // Không cần gọi lại nếu có vị thế
        return;
    }

    addLog('Bắt đầu chu kỳ giao dịch mới...');

    try {
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`USDT khả dụng: ${parseFloat(usdtAsset).toFixed(2)}`);

        if (usdtAsset < INITIAL_INVESTMENT_AMOUNT) {
            addLog(`Số dư USDT quá thấp (${usdtAsset.toFixed(2)} USDT). Dừng mở lệnh. Đợi số dư đủ.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const symbolInfo = await getSymbolDetails(TARGET_COIN_SYMBOL);
        if (!symbolInfo || !symbolInfo.maxLeverage) {
            addLog(`Không thể lấy thông tin chi tiết hoặc đòn bẩy cho ${TARGET_COIN_SYMBOL}. Hủy chu kỳ.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        addLog(`Chuẩn bị mở lệnh ${nextTradeDirection} cho ${TARGET_COIN_SYMBOL} với vốn ${currentInvestmentAmount} USDT và đòn bẩy ${symbolInfo.maxLeverage}x.`);
        await openPosition(TARGET_COIN_SYMBOL, nextTradeDirection, usdtAsset, symbolInfo.maxLeverage);

    } catch (error) {
        addLog(`Lỗi trong chu kỳ giao dịch chính: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng.`);
            stopBotLogicInternal();
        } else {
            // Tạm dừng một chút sau lỗi rồi mới lên lịch lại để tránh spam
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

        consecutiveApiErrors = 0; // Reset lỗi khi khởi động thành công

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('Lỗi tải exchangeInfo. Bot dừng.');
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        // --- KHỞI TẠO WEBSOCKET ---
        listenKey = await getListenKey(); // Lấy listenKey lần đầu
        if (listenKey) {
            setupUserDataStream(listenKey);
        } else {
            addLog("Không thể khởi tạo User Data Stream. Bot sẽ tiếp tục nhưng có thể thiếu thông tin cập nhật PNL.");
        }

        // Khởi tạo Market Data Stream với symbol mục tiêu (cho mục đích cập nhật PNL chưa hiện thực hóa UI)
        setupMarketDataStream(TARGET_COIN_SYMBOL);
        // --- KẾT THÚC KHỞI TẠO WEBSOCKET ---

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Vốn ban đầu cho mỗi lệnh: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);

        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT'; // Reset hướng lệnh về ban đầu khi khởi động

        // Chỉ chạy chu kỳ chính sau khi tất cả khởi tạo xong
        scheduleNextMainCycle();

        // Đảm bảo positionCheckInterval được thiết lập nếu bot đang chạy
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
            }, 5000); // Tăng lên 5 giây
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
    // --- ĐÓNG WEBSOCKET ---
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
    listenKey = null; // Reset listenKey
    currentMarketPrice = null; // Reset cached price
    // --- KẾT THÚC ĐÓNG WEBSOCKET ---

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

// --- KHỞI TẠO WEB SERVER VÀ CÁC API ENDPOINT ---
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

// Endpoint để lấy thống kê giao dịch
app.get('/api/bot_stats', async (req, res) => {
    try {
        let openPositionsData = [];
        if (currentOpenPosition) {
            openPositionsData.push({
                symbol: currentOpenPosition.symbol,
                side: currentOpenPosition.side,
                quantity: currentOpenPosition.quantity,
                entryPrice: currentOpenPosition.entryPrice,
                currentPrice: currentOpenPosition.currentPrice || 0, // Cập nhật từ manageOpenPosition
                unrealizedPnl: currentOpenPosition.unrealizedPnl || 0, // Cập nhật từ manageOpenPosition
                pricePrecision: currentOpenPosition.pricePrecision
            });
        }

        res.json({
            success: true,
            data: {
                totalProfit: totalProfit,
                totalLoss: totalLoss,
                netPNL: netPNL,
                currentOpenPositions: openPositionsData
            }
        });
    } catch (error) {
        console.error('Lỗi khi lấy thống kê bot:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy thống kê bot.' });
    }
});


// Endpoint để cấu hình các tham số từ frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body;

    API_KEY = apiKey.trim();
    SECRET_KEY = secretKey.trim();

    if (coinConfigs && coinConfigs.length > 0) {
        const config = coinConfigs[0];
        TARGET_COIN_SYMBOL = config.symbol.trim().toUpperCase();
        INITIAL_INVESTMENT_AMOUNT = parseFloat(config.initialAmount);
        APPLY_DOUBLE_STRATEGY = !!config.applyDoubleStrategy;
    } else {
        addLog("Cảnh báo: Không có cấu hình đồng coin nào được gửi.");
    }

    currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
    consecutiveLossCount = 0;
    nextTradeDirection = 'SHORT';

    addLog(`Đã cập nhật cấu hình:`);
    addLog(`  API Key: ${API_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Secret Key: ${SECRET_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Đồng coin: ${TARGET_COIN_SYMBOL}`);
    addLog(`  Số vốn ban đầu: ${INITIAL_INVESTMENT_AMOUNT} USDT`);
    addLog(`  Chiến lược x2 vốn: ${APPLY_DOUBLE_STRATEGY ? 'Bật' : 'Tắt'}`);

    // Khi cấu hình thay đổi, nếu bot đang chạy, cần khởi tạo lại WS stream với symbol mới
    if (botRunning && TARGET_COIN_SYMBOL && marketWs?.readyState === WebSocket.OPEN) {
        addLog(`Cấu hình symbol thay đổi, khởi tạo lại Market Data Stream cho ${TARGET_COIN_SYMBOL}.`);
        setupMarketDataStream(TARGET_COIN_SYMBOL);
    }

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
