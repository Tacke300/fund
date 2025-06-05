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

// Biến cờ tổng thể điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// Biến cờ để tránh gửi nhiều lệnh đóng cùng lúc cho một symbol
const isClosingPosition = new Map(); // Map<symbol, boolean>

// Map để lưu trữ cấu hình và trạng thái giao dịch cho TỪNG CẶP COIN
const coinConfigurations = new Map(); // Map<symbol, { config: {}, state: {} }>

// === START - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===
let consecutiveApiErrors = 0; // Đếm số lỗi API liên tiếp
const MAX_CONSECUTIVE_API_ERRORS = 5; // Số lỗi API liên tiếp tối đa cho phép trước khi tạm dừng bot
const ERROR_RETRY_DELAY_MS = 1000; // Độ trễ (ms) khi bot tạm dừng sau nhiều lỗi (ví dụ: 1 giây)

// Cache các thông điệp log để tránh spam quá nhiều dòng giống nhau liên tiếp
const logCounts = {}; // { messageHash: { count: number, lastLoggedTime: Date, originalMessage: string } }
const LOG_COOLDOWN_MS = 1000; // 1 giây cooldown cho các log không quan trọng lặp lại

// Custom Error class cho lỗi API nghiêm trọng
class CriticalApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CriticalApiError';
    }
}
// === END - BIẾN QUẢN LÝ LỖI VÀ TẦN SUẤT LOG ===


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH CHUNG (GIÁ TRỊ MẶC ĐỊNH) ---
// Cấu hình Take Profit & Stop Loss - có thể cấu hình riêng cho từng coin sau này
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.60; // 60% lãi trên VỐN
const STOP_LOSS_PERCENTAGE_MAIN = 0.175;   // 17.5% lỗ trên VỐN

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

// THAY ĐỔI MỚI: Số lần thử lại kiểm tra vị thế sau khi đóng và thời gian delay (đã loại bỏ delay)
const RETRY_CHECK_POSITION_ATTEMPTS = 0;
const RETRY_CHECK_POSITION_DELAY_MS = 0;

// Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính tổng thể (runTradingLogicForAllSymbols)
let nextScheduledCycleTimeout = null;
// Biến để lưu trữ setTimeout cho việc tự động khởi động lại bot sau lỗi nghiêm trọng
let retryBotTimeout = null;


// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1235; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/tung01-out.log'; // Cần điều chỉnh nếu dùng PM2
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
 * Hàm đóng vị thế hiện tại và xử lý logic PNL, vốn, hướng lệnh cho một symbol cụ thể
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {number} quantity - Số lượng vị thế cần đóng.
 * @param {string} reason - Lý do đóng vị thế (TP, SL, Hết thời gian, Manual, v.v.).
 */
async function closePosition(symbol, quantity, reason) {
    const coinData = coinConfigurations.get(symbol);
    if (!coinData) {
        addLog(`Lỗi: Không tìm thấy cấu hình cho symbol ${symbol}. Không thể đóng lệnh.`);
        return;
    }
    const coinState = coinData.state;
    const coinConfig = coinData.config;

    if (isClosingPosition.get(symbol)) {
        addLog(`Đang trong quá trình đóng vị thế cho ${symbol}. Bỏ qua yêu cầu đóng mới.`);
        return;
    }
    isClosingPosition.set(symbol, true); // Đặt cờ để ngăn các lệnh đóng chồng chéo

    const positionSideBeforeClose = coinState.currentOpenPosition?.side;

    addLog(`Đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantity}.`);
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`);
            isClosingPosition.set(symbol, false);
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
                reduceOnly: 'true' // Đảm bảo lệnh này chỉ dùng để giảm vị thế
            });

            addLog(`Đã gửi lệnh đóng ${positionSideBeforeClose} ${symbol}. Lý do: ${reason}.`);

            // --- Lấy PNL thực tế sau khi lệnh đóng khớp (đợi 1s) ---
            await sleep(1000);
            const updatedPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            const closedPositionOnBinance = updatedPositions.find(p => p.symbol === symbol); // Lấy lại vị thế (nó có thể đã mất nếu đóng hoàn toàn)

            if (closedPositionOnBinance && parseFloat(closedPositionOnBinance.positionAmt) === 0) {
                const entryPrice = parseFloat(currentPositionOnBinance.entryPrice);
                const closePrice = await getCurrentPrice(symbol); // Lấy giá hiện tại làm giá đóng
                const pnl = (positionSideBeforeClose === 'LONG')
                    ? (closePrice - entryPrice) * actualQuantityToClose
                    : (entryPrice - closePrice) * actualQuantityToClose;

                if (pnl > 0) {
                    coinState.totalProfit += pnl;
                } else {
                    coinState.totalLoss += Math.abs(pnl);
                }
                coinState.netPNL = coinState.totalProfit - coinState.totalLoss;

                addLog([
                    `🔴 ${symbol}: Đã đóng ${positionSideBeforeClose}`,
                    `├─ Lý do: ${reason}`,
                    `├─ PNL: ${pnl.toFixed(2)} USDT`,
                    `├─ Tổng Lời: ${coinState.totalProfit.toFixed(2)} USDT`,
                    `├─ Tổng Lỗ: ${coinState.totalLoss.toFixed(2)} USDT`,
                    `└─ PNL Ròng: ${coinState.netPNL.toFixed(2)} USDT`
                ].join('\n'));
            } else {
                addLog(`${symbol}: Không thể xác nhận PNL. Vị thế có thể còn sót.`);
            }
        }

        // --- Xử lý logic reset vốn/lượt lỗ và xác định hướng lệnh tiếp theo ---
        if (reason.includes('TP')) { // Vị thế đóng do đạt TP
            coinState.consecutiveLossCount = 0; // Reset số lần lỗ liên tiếp
            coinState.currentInvestmentAmount = coinConfig.initialAmount; // Về lại vốn ban đầu
            coinState.nextTradeDirection = positionSideBeforeClose; // Giữ nguyên hướng lệnh
            addLog(`${symbol}: Đã đạt TP. Reset vốn về ${coinState.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${coinState.nextTradeDirection}.`);
        } else if (reason.includes('SL') || reason.includes('Hết thời gian') || reason.includes('kích hoạt ngay')) { // Vị thế đóng do chạm SL hoặc hết thời gian
            if (coinConfig.applyDoubleStrategy) {
                coinState.consecutiveLossCount++; // Tăng số lần lỗ liên tiếp
                addLog(`${symbol}: Đã chạm SL hoặc hết thời gian. Số lần lỗ liên tiếp: ${coinState.consecutiveLossCount}.`);
                if (coinState.consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                    coinState.currentInvestmentAmount = coinConfig.initialAmount; // Về lại vốn ban đầu sau 5 lần lỗ
                    coinState.consecutiveLossCount = 0;
                    addLog(`${symbol}: Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${coinState.currentInvestmentAmount} USDT và lượt lỗ về 0.`);
                } else {
                    coinState.currentInvestmentAmount *= 2; // Gấp đôi vốn cho lệnh tiếp theo
                    addLog(`${symbol}: Gấp đôi vốn cho lệnh tiếp theo: ${coinState.currentInvestmentAmount} USDT.`);
                }
            } else {
                addLog(`${symbol}: Đã chạm SL hoặc hết thời gian. Không áp dụng chiến lược x2 vốn.`);
                coinState.currentInvestmentAmount = coinConfig.initialAmount; // Giữ nguyên vốn ban đầu
                coinState.consecutiveLossCount = 0; // Reset số lượt lỗ
            }
            // Đảo ngược hướng lệnh dựa trên hướng lệnh đã bị đóng
            coinState.nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG');
            addLog(`${symbol}: Lệnh tiếp theo: ${coinState.nextTradeDirection}.`);
        } else {
            // Các lý do đóng khác (ví dụ: đóng thủ công, lỗi không rõ, không đủ số dư)
            // Giả định là một trường hợp cần reset trạng thái về ban đầu
            coinState.currentInvestmentAmount = coinConfig.initialAmount;
            coinState.consecutiveLossCount = 0;
            // Vẫn đảo chiều nếu lý do không rõ là do lỗi
            coinState.nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG');
            addLog(`${symbol}: Lệnh đóng do lý do đặc biệt (${reason}). Reset vốn về ${coinState.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${coinState.nextTradeDirection}.`);
        }
        // --- Kết thúc xử lý logic ---

        coinState.currentOpenPosition = null; // Chỉ reset sau khi đã xử lý logic nextTradeDirection
        if (coinState.positionCheckIntervalId) {
            clearInterval(coinState.positionCheckIntervalId);
            coinState.positionCheckIntervalId = null;
        }
        await cancelOpenOrdersForSymbol(symbol); // Hủy mọi lệnh chờ còn lại cho symbol này
        await checkAndHandleRemainingPosition(symbol); // Kiểm tra lại nếu còn vị thế sót

        // Không gọi scheduleNextMainCycle() ở đây, nó sẽ được gọi bởi vòng lặp tổng thể
    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol}: ${error.msg || error.message}`);
    } finally {
        isClosingPosition.set(symbol, false); // Reset cờ dù thành công hay thất bại
    }
}

// Hàm kiểm tra và xử lý vị thế còn sót lại (đã bỏ delay và retry)
async function checkAndHandleRemainingPosition(symbol) {
    addLog(`Kiểm tra vị thế còn sót cho ${symbol}...`);
    const coinData = coinConfigurations.get(symbol);
    if (!coinData) return; // Bảo vệ nếu coinData không tồn tại
    const coinState = coinData.state;

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
            coinState.currentOpenPosition = { // Tạo tạm currentOpenPosition để hàm closePosition hoạt động
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

// Hàm mở lệnh (Long hoặc Short) cho một symbol cụ thể
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    const coinData = coinConfigurations.get(symbol);
    if (!coinData) {
        addLog(`Lỗi: Không tìm thấy cấu hình cho symbol ${symbol}. Không thể mở lệnh.`);
        return;
    }
    const coinState = coinData.state;
    const coinConfig = coinData.config;

    if (coinState.currentOpenPosition) {
        addLog(`Đã có vị thế mở cho ${symbol} (${coinState.currentOpenPosition.symbol}). Bỏ qua mở lệnh mới.`);
        return;
    }

    addLog(`Mở ${tradeDirection} ${symbol}.`);
    addLog(`Mở lệnh với số vốn: ${coinState.currentInvestmentAmount} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`);
            return;
        }

        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`Lỗi đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`);
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol); // Giá thị trường tại thời điểm gửi lệnh
        if (!currentPrice) {
            addLog(`Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            return;
        }
        addLog(`Giá ${symbol} tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = coinState.currentInvestmentAmount;

        if (usdtBalance < capitalToUse) {
            addLog(`Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh ${symbol} (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`);
            // Reset về lệnh ban đầu khi không đủ số dư
            coinState.currentInvestmentAmount = coinConfig.initialAmount;
            coinState.consecutiveLossCount = 0;
            addLog(`Số dư không đủ cho ${symbol}. Reset vốn về ${coinState.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${coinState.nextTradeDirection}.`);
            return;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty) {
            addLog(`Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}) cho ${symbol}. Hủy.`);
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}) cho ${symbol}. Hủy.`);
            return;
        }
        if (quantity <= 0) {
            addLog(`Qty cho ${symbol} là ${quantity}. Không hợp lệ. Hủy.`);
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
        addLog(`Đã đợi 1 giây sau khi gửi lệnh mở cho ${symbol}. Đang lấy giá vào lệnh thực tế từ Binance.`);

        // Lấy thông tin vị thế đang mở để có entryPrice chính xác
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            addLog(`Không tìm thấy vị thế mở cho ${symbol} sau 1 giây. Có thể lệnh không khớp hoặc đã đóng ngay lập tức.`);
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

        addLog(`${symbol}: TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

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

        coinState.currentOpenPosition = {
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

        // Nếu chưa có interval kiểm tra vị thế cho coin này, hãy khởi tạo nó
        if (!coinState.positionCheckIntervalId) {
            coinState.positionCheckIntervalId = setInterval(async () => {
                if (botRunning && coinState.currentOpenPosition) {
                    try {
                        await manageOpenPosition(symbol); // Pass symbol to manageOpenPosition
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ cho ${symbol}: ${error.msg || error.message}.`);
                    }
                } else if (!botRunning && coinState.positionCheckIntervalId) {
                    clearInterval(coinState.positionCheckIntervalId);
                    coinState.positionCheckIntervalId = null;
                }
            }, 300); // Tần suất kiểm tra vị thế cho từng coin
        }

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh cho ${symbol}.`);
            // Lỗi nghiêm trọng ở đây có thể dẫn đến dừng toàn bộ bot
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
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở cho một symbol cụ thể
 * @param {string} symbol - Symbol của cặp giao dịch cần quản lý.
 */
async function manageOpenPosition(symbol) {
    const coinData = coinConfigurations.get(symbol);
    if (!coinData) {
        addLog(`Lỗi: Không tìm thấy cấu hình cho symbol ${symbol}. Không thể quản lý vị thế.`);
        return;
    }
    const coinState = coinData.state;

    if (!coinState.currentOpenPosition || isClosingPosition.get(symbol)) {
        if (!coinState.currentOpenPosition && coinState.positionCheckIntervalId) {
            clearInterval(coinState.positionCheckIntervalId);
            coinState.positionCheckIntervalId = null;
            // Nếu không có vị thế mở, lên lịch chạy lại logic tìm kiếm cơ hội cho coin này
            if (botRunning) scheduleNextMainCycleForSymbol(symbol);
        }
        return;
    }

    const { quantity, initialTPPrice, initialSLPrice, side } = coinState.currentOpenPosition;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        // Nếu vị thế không còn trên sàn Binance
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol: symbol, limit: 10 });
            let closeReason = "đã đóng trên sàn";

            if (recentTrades.length > 0) {
                const latestTrade = recentTrades.find(t =>
                    // Tìm giao dịch khớp với số lượng vị thế ban đầu (có thể có sai số nhỏ)
                    (side === 'LONG' && t.side === 'SELL' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001) ||
                    (side === 'SHORT' && t.side === 'BUY' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001)
                );

                if (latestTrade) {
                    const symbolInfo = exchangeInfoCache[symbol];
                    const tickSize = symbolInfo ? symbolInfo.tickSize : 0.001; // Sử dụng tickSize từ cache

                    const priceDiffTP = Math.abs(parseFloat(latestTrade.price) - initialTPPrice);
                    const priceDiffSL = Math.abs(parseFloat(latestTrade.price) - initialSLPrice);

                    // So sánh với một ngưỡng nhỏ (ví dụ: 2 lần tickSize)
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
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế của ${symbol}.`);
            // Lỗi nghiêm trọng ở đây có thể dẫn đến dừng toàn bộ bot
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
}

// Hàm chạy logic tìm kiếm cơ hội cho MỘT symbol cụ thể
async function runTradingLogicForSymbol(symbol) {
    if (!botRunning) {
        addLog('Bot dừng. Hủy chu kỳ quét cho ' + symbol);
        return;
    }

    const coinData = coinConfigurations.get(symbol);
    if (!coinData) {
        addLog(`Lỗi: Không tìm thấy cấu hình cho symbol ${symbol}. Bỏ qua logic.`);
        return;
    }
    const coinState = coinData.state;
    const coinConfig = coinData.config;

    if (coinState.currentOpenPosition) {
        addLog(`Có vị thế mở cho ${symbol}. Bỏ qua quét mới.`);
        return;
    }

    addLog(`Cố gắng mở lệnh cho ${symbol}...`);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails || typeof symbolDetails.maxLeverage !== 'number' || symbolDetails.maxLeverage <= 1) {
            addLog(`${symbol}: Không có đòn bẩy hợp lệ hoặc không tìm thấy symbol. Sẽ thử lại sau.`);
            return;
        }

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
            addLog(`Lỗi lấy giá cho ${symbol}. Bỏ qua.`);
            return;
        }

        let estimatedQuantity = (coinState.currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
        estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
        estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

        const currentNotional = estimatedQuantity * currentPrice;

        if (currentNotional < symbolDetails.minNotional || estimatedQuantity < symbolDetails.minQty) {
            addLog(`${symbol}: KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh (minNotional/minQty).`);
            return;
        }

        if (availableBalance < coinState.currentInvestmentAmount) {
            addLog(`Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh ${symbol} (${coinState.currentInvestmentAmount.toFixed(2)} USDT). Trở về lệnh ban đầu.`);
            coinState.currentInvestmentAmount = coinConfig.initialAmount;
            coinState.consecutiveLossCount = 0;
            addLog(`Số dư không đủ cho ${symbol}. Reset vốn về ${coinState.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${coinState.nextTradeDirection}.`);
            return;
        }

        addLog(`\nChọn: ${symbol}`);
        addLog(`  + Đòn bẩy: ${symbolDetails.maxLeverage}x | Vốn: ${coinState.currentInvestmentAmount.toFixed(2)} USDT`);
        addLog(`Mở lệnh ${coinState.nextTradeDirection} ngay lập tức.`);

        await openPosition(symbol, coinState.nextTradeDirection, availableBalance, symbolDetails.maxLeverage);

    } catch (error) {
        addLog(`Lỗi trong chu kỳ giao dịch cho ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng tổng thể do lỗi API nghiêm trọng khi xử lý ${symbol}. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            stopBotLogicInternal();
            retryBotTimeout = setTimeout(async () => {
                addLog('Thử khởi động lại bot...');
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
    } finally {
        if (botRunning && !coinState.currentOpenPosition) { // Chỉ lên lịch chạy lại nếu bot vẫn chạy và không có vị thế mở
            scheduleNextMainCycleForSymbol(symbol);
        }
    }
}

// Hàm lên lịch chu kỳ chính của bot cho MỘT symbol (đã bỏ delay)
async function scheduleNextMainCycleForSymbol(symbol) {
    const coinData = coinConfigurations.get(symbol);
    if (!coinData) return; // Bảo vệ nếu coinData không tồn tại
    const coinState = coinData.state;

    if (!botRunning) {
        addLog(`Bot dừng. Không lên lịch chu kỳ mới cho ${symbol}.`);
        clearTimeout(coinState.nextScheduledCycleTimeoutId);
        coinState.nextScheduledCycleTimeoutId = null;
        return;
    }

    if (coinState.currentOpenPosition) {
        // addLog(`Có vị thế mở cho ${symbol}. Chờ đóng vị thế hiện tại.`);
        // manageOpenPosition sẽ được gọi bởi interval riêng của coin này
        return;
    }

    clearTimeout(coinState.nextScheduledCycleTimeoutId);
    // Chạy logic giao dịch ngay lập tức nếu không có vị thế mở
    coinState.nextScheduledCycleTimeoutId = setTimeout(() => runTradingLogicForSymbol(symbol), 2000); // Chạy lại mỗi 2 giây
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

    if (coinConfigurations.size === 0) {
        addLog('Lỗi: Chưa có đồng coin nào được cấu hình để giao dịch.');
        return 'Lỗi: Chưa có đồng coin nào được cấu hình để giao dịch.';
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

        // Khởi tạo trạng thái ban đầu cho TỪNG coin và kích hoạt logic riêng cho từng coin
        for (const [symbol, data] of coinConfigurations.entries()) {
            data.state.currentInvestmentAmount = data.config.initialAmount;
            data.state.consecutiveLossCount = 0;
            data.state.nextTradeDirection = 'SHORT'; // Đặt hướng mặc định khi khởi động cho mỗi coin
            data.state.currentOpenPosition = null; // Đảm bảo không có vị thế cũ từ lần chạy trước
            data.state.totalProfit = 0;
            data.state.totalLoss = 0;
            data.state.netPNL = 0;
            isClosingPosition.set(symbol, false); // Khởi tạo cờ đóng vị thế

            // Đảm bảo interval kiểm tra vị thế và timeout chu kỳ chính được dọn dẹp và khởi tạo lại
            if (data.state.positionCheckIntervalId) {
                clearInterval(data.state.positionCheckIntervalId);
                data.state.positionCheckIntervalId = null;
            }
            if (data.state.nextScheduledCycleTimeoutId) {
                clearTimeout(data.state.nextScheduledCycleTimeoutId);
                data.state.nextScheduledCycleTimeoutId = null;
            }

            // Kích hoạt chu kỳ chính cho từng coin
            scheduleNextMainCycleForSymbol(symbol);
        }

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

    clearTimeout(nextScheduledCycleTimeout); // Dừng lịch chạy tổng thể (nếu có, mặc dù không dùng ở đây)

    // Dừng tất cả các interval và timeout riêng cho từng coin
    for (const [symbol, data] of coinConfigurations.entries()) {
        if (data.state.positionCheckIntervalId) {
            clearInterval(data.state.positionCheckIntervalId);
            data.state.positionCheckIntervalId = null;
        }
        if (data.state.nextScheduledCycleTimeoutId) {
            clearTimeout(data.state.nextScheduledCycleTimeoutId);
            data.state.nextScheduledCycleTimeoutId = null;
        }
        data.state.currentOpenPosition = null; // Xóa vị thế mở
        isClosingPosition.set(symbol, false); // Reset cờ đóng vị thế
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
        if (botProcess) {
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI BOT: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                }
                // Thêm trạng thái của từng coin
                if (botRunning && coinConfigurations.size > 0) {
                    statusMessage += ' | COINS: ';
                    let coinStatuses = [];
                    for (const [symbol, data] of coinConfigurations.entries()) {
                        const coinState = data.state;
                        if (coinState.currentOpenPosition) {
                            coinStatuses.push(`${symbol}: Đang mở ${coinState.currentOpenPosition.side} (${coinState.currentInvestmentAmount.toFixed(2)} USDT)`);
                        } else {
                            coinStatuses.push(`${symbol}: Chờ lệnh (${coinState.currentInvestmentAmount.toFixed(2)} USDT)`);
                        }
                    }
                    statusMessage += coinStatuses.join(', ');
                }
            }
        } else {
            statusMessage = `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi lấy trạng thái PM2:', error);
        res.status(500).send(`Bot: Lỗi lấy trạng thái. (${error.message || error})`);
    }
});

// Endpoint để cấu hình các tham số từ frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body;

    API_KEY = apiKey.trim();
    SECRET_KEY = secretKey.trim();

    coinConfigurations.clear(); // Xóa cấu hình cũ trước khi thêm mới

    if (Array.isArray(coinConfigs) && coinConfigs.length > 0) {
        coinConfigs.forEach(coin => {
            const symbol = coin.symbol.trim().toUpperCase();
            const initialAmount = parseFloat(coin.initialAmount);
            const applyDoubleStrategy = !!coin.applyDoubleStrategy;

            if (symbol && !isNaN(initialAmount) && initialAmount > 0) {
                coinConfigurations.set(symbol, {
                    config: {
                        initialAmount: initialAmount,
                        applyDoubleStrategy: applyDoubleStrategy,
                        takeProfitPercentage: TAKE_PROFIT_PERCENTAGE_MAIN,
                        stopLossPercentage: STOP_LOSS_PERCENTAGE_MAIN
                    },
                    state: {
                        currentInvestmentAmount: initialAmount,
                        consecutiveLossCount: 0,
                        nextTradeDirection: 'SHORT', // Mặc định khi cấu hình mới
                        currentOpenPosition: null,
                        positionCheckIntervalId: null,
                        nextScheduledCycleTimeoutId: null,
                        totalProfit: 0,
                        totalLoss: 0,
                        netPNL: 0
                    }
                });
                addLog(`Đã thêm cấu hình cho ${symbol}: ${initialAmount} USDT, x2 vốn: ${applyDoubleStrategy ? 'Bật' : 'Tắt'}`);
            } else {
                addLog(`Cấu hình không hợp lệ cho coin: ${JSON.stringify(coin)}`);
            }
        });
    } else {
        addLog('Không có đồng coin nào được cấu hình.');
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
    addLog(`Web server đang chạy trên cổng ${WEB_SERVER_PORT}`);
    addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`);
});
