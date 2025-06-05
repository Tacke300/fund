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

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// THAY ĐỔI LỚN: Quản lý trạng thái cho TỪNG CẶP COIN
// Thay vì biến toàn cục, dùng Map để lưu trạng thái của mỗi cặp coin
const configuredCoinPairs = new Map(); // Map<symbol, { initialInvestmentAmount, applyDoubleStrategy, currentInvestmentAmount, consecutiveLossCount, nextTradeDirection, currentOpenPosition, positionCheckInterval, nextScheduledCycleTimeout, isClosingPosition }>

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


// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH (GIÁ TRỊ MẶC ĐỊNH CHO MỖI CẶP) ---
// Sẽ được override từ configuredCoinPairs

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

// === MỚI THÊM/ĐIỀU CHỈNH: TỶ LỆ CHỐT LỜI/CẮT LỖ (Dạng thập phân) ===
// Cấu hình tỷ lệ chốt lời và cắt lỗ cho từng cặp coin (áp dụng khi mở lệnh)
const TAKE_PROFIT_PERCENTAGE_MAIN = 0.005; // 0.5%
const STOP_LOSS_PERCENTAGE_MAIN = 0.005;   // 0.5%


// Tổng PNL (lời/lỗ) để hiển thị trong log và trên UI (tổng cộng của tất cả các cặp)
let overallBotStats = {
    totalProfit: 0,
    totalLoss: 0,
    netPNL: 0,
    currentOpenPositions: [] // Mảng các vị thế đang mở
};


// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 1235; // Cổng cho giao diện web
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log'; // Cần điều chỉnh nếu dùng PM2
const THIS_BOT_PM2_NAME = 'futu'; // Cần điều chỉnh nếu dùng PM2

// --- HÀM TIỆN ÍCH ---

function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    // Tạo hash đơn giản cho message để nhóm các log lặp lại
    const messageHash = crypto.createHash('md5').update(message).digest('hex');

    if (logCounts[messageHash]) {
        logCounts[messageHash].count++;
        const lastLoggedTime = logCounts[messageHash].lastLoggedTime;

        if ((now.getTime() - lastLoggedTime.getTime()) < LOG_COOLDOWN_MS) {
            return; // Bỏ qua nếu quá sớm
        } else {
            // Log lại và reset count
            if (logCounts[messageHash].count > 1) {
                console.log(`[${time}] (Lặp lại x${logCounts[messageHash].count}) ${message}`);
            }
            logCounts[messageHash] = { count: 1, lastLoggedTime: now };
        }
    } else {
        logCounts[messageHash] = { count: 1, lastLoggedTime: now };
    }
    console.log(logEntry); // Ghi ra console của server
}

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
        } else if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp. Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error; // Vẫn throw lỗi để logic gọi có thể xử lý (ví dụ: sleep và retry)
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
        if (error.code === 404) {
            addLog("  -> Lỗi 404. Đường dẫn API sai.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  -> Lỗi mạng.");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            addLog(`Lỗi API liên tiếp. Dừng bot.`, true);
            throw new CriticalApiError("Lỗi API nghiêm trọng, bot dừng.");
        }
        throw error; // Vẫn throw lỗi để logic gọi có thể xử lý
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
        serverTimeOffset = 0; // Đặt về 0 để không gây lỗi lệch thời gian thêm
        throw error; // Vẫn throw để dừng khởi động nếu không đồng bộ được
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
        if (error instanceof CriticalApiError) throw error; // Re-throw critical errors
        return null; // Trả về null nếu lỗi không nghiêm trọng
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
        if (error instanceof CriticalApiError) throw error; // Re-throw critical errors
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
        throw error; // Throw để dừng bot nếu không lấy được exchangeInfo
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
        // CriticalApiError từ getExchangeInfo hoặc getLeverageBracketForSymbol sẽ được re-throw
        // và xử lý ở tầng cao hơn (startBotLogicInternal, runTradingLogic, closePosition)
        addLog(`Lỗi tổng hợp chi tiết symbol cho ${symbol}: ${error.msg || error.message}`);
        throw error;
    }
}

// Lấy giá hiện tại của một symbol
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        addLog(`Lỗi khi lấy giá cho ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) throw error; // Re-throw critical errors
        return null;
    }
}

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`Hủy tất cả lệnh chờ cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`Đã hủy tất cả lệnh chờ cho ${symbol}.`);
    } catch (error) {
        if (error.code === -2011) { // Lỗi lệnh không tồn tại
            addLog(`Không có lệnh chờ nào cho ${symbol} để hủy.`);
        } else {
            addLog(`Lỗi hủy lệnh chờ cho ${symbol}: ${error.msg || error.message}`);
            if (error instanceof CriticalApiError) throw error; // Re-throw critical errors
        }
    }
}

// Hàm chờ một khoảng thời gian
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Hàm đóng vị thế và xác định lý do đóng.
 * Đảm bảo CHỜ lịch sử Binance để xác định PnL thực tế.
 * @param {string} symbol
 * @param {number} quantity - Số lượng vị thế ban đầu của lệnh (để tìm trong userTrades)
 * @param {string} reason Lý do ban đầu (ví dụ: 'Kiểm tra vị thế', 'Lỗi', 'Thủ công')
 */
async function closePosition(symbol, quantity, reason) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!coinConfig) {
        addLog(`Lỗi: Không tìm thấy cấu hình cho ${symbol}. Không thể đóng lệnh.`);
        return;
    }

    if (coinConfig.isClosingPosition) {
        addLog(`[${symbol}] Đang trong quá trình đóng lệnh. Bỏ qua yêu cầu đóng lệnh mới.`);
        return;
    }
    coinConfig.isClosingPosition = true; // Đặt cờ cho symbol này

    // Lưu lại thông tin vị thế trước khi đóng để đối chiếu
    const positionSideBeforeClose = coinConfig.currentOpenPosition?.side;
    const entryPriceBeforeClose = coinConfig.currentOpenPosition?.entryPrice;
    const initialMarginBeforeClose = coinConfig.currentOpenPosition?.initialMargin; // Vốn ban đầu của lệnh đó

    addLog(`Đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do ban đầu: ${reason}). Qty ban đầu: ${quantity}.`);

    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`);
            coinConfig.isClosingPosition = false; // Reset cờ
            return;
        }

        // --- BƯỚC 1: HỦY TẤT CẢ LỆNH CHỜ HIỆN TẠI (TP/SL) ---
        try {
            await cancelOpenOrdersForSymbol(symbol);
        } catch (error) {
            addLog(`[${symbol}] Cảnh báo: Không thể hủy lệnh chờ do lỗi: ${error.msg || error.message}. Sẽ tiếp tục đóng vị thế.`);
        }

        // --- BƯỚC 2: KIỂM TRA LẠI VỊ THẾ TRÊN BINANCE. Đảm bảo nó đã đóng hoàn toàn. ---
        // Phần này cần thiết để đảm bảo lệnh đã thực sự đóng trên sàn
        addLog(`[${symbol}] Bắt đầu chờ xác nhận vị thế đóng hoàn toàn trên Binance... (Chờ vô cực)`);
        let positionClosedOnBinance = false;
        const checkPositionIntervalMs = 500; // Kiểm tra mỗi 500ms
        let checkPositionAttempts = 0;

        while (!positionClosedOnBinance && botRunning) {
            checkPositionAttempts++;
            try {
                const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
                const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
                if (!p || parseFloat(p.positionAmt) === 0) {
                    positionClosedOnBinance = true;
                    addLog(`[${symbol}] Xác nhận: Vị thế đã đóng hoàn toàn trên Binance sau ${checkPositionAttempts} lần kiểm tra.`);
                } else {
                    addLog(`[${symbol}] Vị thế vẫn còn mở (${p.positionAmt}). Đang chờ... (Lần ${checkPositionAttempts})`);
                    // Nếu vị thế vẫn còn, có thể cần gửi lệnh đóng thị trường nếu lý do gọi là đóng khẩn cấp
                    // Tuy nhiên, ở đây chúng ta giả định manageOpenPosition đã phát hiện vị thế đã đóng.
                    await sleep(checkPositionIntervalMs);
                }
            } catch (error) {
                addLog(`[${symbol}] Lỗi khi kiểm tra vị thế trong lúc chờ đóng: ${error.msg || error.message}. Sẽ thử lại sau ${checkPositionIntervalMs / 1000}s.`);
                await sleep(checkPositionIntervalMs);
                if (error instanceof CriticalApiError) {
                    throw error;
                }
            }
        }

        if (!botRunning && !positionClosedOnBinance) {
            addLog(`[${symbol}] Bot đã dừng trong khi chờ vị thế đóng. Hủy quá trình.`);
            coinConfig.isClosingPosition = false;
            return;
        }

        // --- BƯỚC 3: TÌM GIAO DỊCH ĐÓNG LỆNH TRONG LỊCH SỬ USER TRADES ĐỂ CÓ PNL THỰC TẾ ---
        // ĐÂY LÀ PHẦN BẮT BUỘC ĐỢI PNL VỊ THẾ TỪ BINANCE
        addLog(`[${symbol}] BẮT ĐẦU CHỜ LỊCH SỬ BINANCE CÓ PNL VỊ THẾ ĐÃ ĐÓNG... (Chờ vô cực)`);
        let latestClosingTrade = null;
        const checkTradeIntervalMs = 1000; // Kiểm tra mỗi 1 giây
        let checkTradeAttempts = 0;
        // Bắt đầu tìm từ 24h trước. Có thể tăng thêm nếu bạn đóng lệnh và muốn kiểm tra lại sau rất lâu.
        const searchStartTime = Date.now() - (24 * 60 * 60 * 1000); 

        while (!latestClosingTrade && botRunning) {
            checkTradeAttempts++;
            try {
                const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', {
                    symbol: symbol,
                    limit: 100, // Tăng giới hạn để tìm thấy nhanh hơn
                    startTime: searchStartTime
                });

                // Tìm giao dịch đóng lệnh. Quan trọng: PnL chỉ được tính khi trade đã xác nhận.
                // Điều kiện khớp: Trade Qty phải khớp với Quantity của lệnh bot đã mở (hoặc gần đúng), và side phải ngược lại.
                // Thêm điều kiện parseFloat(t.realizedPnl) !== 0 để đảm bảo đó là một giao dịch đóng vị thế có lãi/lỗ thực sự.
                latestClosingTrade = recentTrades.find(t => {
                    const tradeQty = Math.abs(parseFloat(t.qty));
                    const tradeSide = t.side;

                    // Đối với lệnh đóng TP/SL, lượng khớp có thể hơi khác lượng mở ban đầu một chút do cách Binance thực hiện
                    // hoặc do bạn đóng một phần. Sử dụng dung sai để khớp lệnh chính xác hơn.
                    const isMatchingLongClose = (positionSideBeforeClose === 'LONG' && tradeSide === 'SELL' && Math.abs(tradeQty - quantity) < (quantity * 0.0001)); // 0.01% dung sai
                    const isMatchingShortClose = (positionSideBeforeClose === 'SHORT' && tradeSide === 'BUY' && Math.abs(tradeQty - quantity) < (quantity * 0.0001));

                    return (isMatchingLongClose || isMatchingShortClose) && parseFloat(t.realizedPnl) !== 0;
                });

                if (latestClosingTrade) {
                    addLog(`[${symbol}] Đã tìm thấy giao dịch đóng lệnh có PNL trong lịch sử sau ${checkTradeAttempts} lần kiểm tra.`);
                } else {
                    addLog(`[${symbol}] Lịch sử Binance chưa có giao dịch đóng lệnh có PNL tương ứng. Đang chờ... (Lần ${checkTradeAttempts})`);
                    await sleep(checkTradeIntervalMs);
                }
            } catch (error) {
                addLog(`[${symbol}] Lỗi khi tìm giao dịch trong lịch sử: ${error.msg || error.message}. Sẽ thử lại sau ${checkTradeIntervalMs / 1000}s.`);
                await sleep(checkTradeIntervalMs);
                if (error instanceof CriticalApiError) {
                    throw error;
                }
            }
        }

        if (!botRunning && !latestClosingTrade) {
            addLog(`[${symbol}] Bot đã dừng trong khi chờ tìm giao dịch đóng có PNL. Hủy quá trình.`);
            coinConfig.isClosingPosition = false;
            return;
        }

        // --- BƯỚC 4: LẤY PNL THỰC TẾ VÀ CẬP NHẬT THỐNG KÊ ---
        let pnlValue = 0;
        let closePrice = 0;
        let finalPnlReason = reason; // Lý do ban đầu vẫn được dùng làm fallback

        if (latestClosingTrade) {
            closePrice = parseFloat(latestClosingTrade.price);
            pnlValue = parseFloat(latestClosingTrade.realizedPnl); // LẤY PNL THỰC TẾ TỪ BINANCE

            if (pnlValue > 0) {
                finalPnlReason = "Vị thế LÃI (từ lịch sử Binance PnL)";
            } else if (pnlValue < 0) {
                finalPnlReason = "Vị thế LỖ (từ lịch sử Binance PnL)";
            } else {
                finalPnlReason = "Vị thế HÒA VỐN (từ lịch sử Binance PnL)";
            }
        } else {
             // Trường hợp này không nên xảy ra nếu vòng lặp chờ đã thành công
             addLog(`[${symbol}] LỖI NGHIÊM TRỌNG: Đã đóng vị thế nhưng KHÔNG THỂ tìm thấy giao dịch đóng lệnh gần nhất có PNL. PNL sẽ là 0.`);
             pnlValue = 0; // Đảm bảo PNL là 0
        }

        // Cập nhật tổng lời/lỗ toàn bộ bot
        if (pnlValue > 0) {
            overallBotStats.totalProfit += pnlValue;
        } else {
            overallBotStats.totalLoss += Math.abs(pnlValue);
        }
        overallBotStats.netPNL = overallBotStats.totalProfit - overallBotStats.totalLoss;

        addLog([
            `🔴 Đã đóng ${positionSideBeforeClose} ${symbol}`,
            `├─ Lý do xác nhận: ${finalPnlReason}`,
            `├─ Giá đóng thực tế: ${closePrice.toFixed(symbolInfo.pricePrecision)}`,
            `├─ PNL THỰC TẾ: ${pnlValue.toFixed(2)} USDT`,
            `├─ Tổng Lời Bot: ${overallBotStats.totalProfit.toFixed(2)} USDT`,
            `├─ Tổng Lỗ Bot: ${overallBotStats.totalLoss.toFixed(2)} USDT`,
            `└─ PNL Ròng Bot: ${overallBotStats.netPNL.toFixed(2)} USDT`
        ].join('\n'));

        // --- BƯỚC 5: XỬ LÝ LOGIC QUYẾT ĐỊNH CHIỀU GIAO DỊCH TIẾP THEO DỰA TRÊN PNL THỰC TẾ ---
        if (pnlValue > 0) { // Nếu có lãi
            coinConfig.consecutiveLossCount = 0;
            coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
            coinConfig.nextTradeDirection = positionSideBeforeClose; // Lãi: mở vị thế CÙNG CHIỀU
            addLog(`[${symbol}] LÃI (${pnlValue.toFixed(2)} USDT). Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${coinConfig.nextTradeDirection}.`);
        } else { // Nếu hòa vốn hoặc lỗ (pnlValue <= 0)
            if (coinConfig.applyDoubleStrategy) {
                coinConfig.consecutiveLossCount++;
                addLog(`[${symbol}] HÒA VỐN/LỖ (${pnlValue.toFixed(2)} USDT). Số lần lỗ liên tiếp: ${coinConfig.consecutiveLossCount}.`);
                if (coinConfig.consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                    coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
                    coinConfig.consecutiveLossCount = 0;
                    addLog(`[${symbol}] Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp. Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0.`);
                } else {
                    coinConfig.currentInvestmentAmount *= 2;
                    addLog(`[${symbol}] Gấp đôi vốn cho lệnh tiếp theo: ${coinConfig.currentInvestmentAmount} USDT.`);
                }
            } else {
                 addLog(`[${symbol}] HÒA VỐN/LỖ (${pnlValue.toFixed(2)} USDT). Không áp dụng chiến lược x2 vốn.`);
                 coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
                 coinConfig.consecutiveLossCount = 0;
            }
            coinConfig.nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); // Lỗ: ĐẢO CHIỀU
            addLog(`[${symbol}] Lệnh tiếp theo: ${coinConfig.nextTradeDirection}.`);
        }

        // --- BƯỚC 6: DỌN DẸP TRẠNG THÁI CHO CẶP COIN NÀY ---
        coinConfig.currentOpenPosition = null;
        overallBotStats.currentOpenPositions = overallBotStats.currentOpenPositions.filter(pos => pos.symbol !== symbol);

        if (coinConfig.positionCheckInterval) {
            clearInterval(coinConfig.positionCheckInterval);
            coinConfig.positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol); // Đảm bảo không còn lệnh chờ nào sau khi đóng
        coinConfig.isClosingPosition = false; // Reset cờ cho symbol này

        // Kích hoạt chu kỳ chính của riêng cặp coin này để mở lệnh mới nếu bot đang chạy
        if(botRunning) scheduleNextMainCycle(symbol);

    } catch (error) {
        addLog(`Lỗi đóng vị thế ${symbol}: ${error.msg || error.message}`);
        coinConfig.isClosingPosition = false; // Đảm bảo cờ được reset ngay cả khi lỗi
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi đóng lệnh của ${symbol}.`);
            stopBotLogicInternal(); // Dừng toàn bộ bot nếu có lỗi API nghiêm trọng
            if (!retryBotTimeout) {
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...');
                    await startBotLogicInternal(Array.from(configuredCoinPairs.values()).map(cfg => ({
                        symbol: cfg.symbol,
                        initialAmount: cfg.initialInvestmentAmount,
                        applyDoubleStrategy: cfg.applyDoubleStrategy
                    }))); // Truyền lại cấu hình cũ
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        }
    }
}


/**
 * Hàm kiểm tra và quản lý vị thế đang mở
 * @param {string} symbol - Symbol của cặp coin cần quản lý
 */
async function manageOpenPosition(symbol) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!coinConfig || !coinConfig.currentOpenPosition || coinConfig.isClosingPosition) {
        // Nếu không còn vị thế mở hoặc đang trong quá trình đóng, hủy interval và schedule chu kỳ mới
        if (!coinConfig?.currentOpenPosition && coinConfig?.positionCheckInterval) {
            clearInterval(coinConfig.positionCheckInterval);
            coinConfig.positionCheckInterval = null;
            if(botRunning) scheduleNextMainCycle(symbol);
        }
        return;
    }

    const { quantity } = coinConfig.currentOpenPosition; // Lấy quantity từ currentOpenPosition ban đầu

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`[${symbol}] Vị thế đã đóng trên sàn. Đang kích hoạt quá trình xác định PnL từ lịch sử.`);
            // Gọi closePosition với lý do chung, sau đó hàm closePosition sẽ tự xác minh lại PnL từ lịch sử
            await closePosition(symbol, quantity, "vị thế đã đóng trên sàn");
            return;
        }

        // Cập nhật PNL cho vị thế đang mở để hiển thị trên UI
        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice !== null) {
            const entryPrice = coinConfig.currentOpenPosition.entryPrice;
            const positionAmount = parseFloat(currentPositionOnBinance.positionAmt);
            let unrealizedPnl = parseFloat(currentPositionOnBinance.unRealizedProfit);

            // Cập nhật thông tin vị thế hiện tại vào overallBotStats
            const existingOpenPosIndex = overallBotStats.currentOpenPositions.findIndex(pos => pos.symbol === symbol);
            const positionDetails = {
                symbol: symbol,
                side: positionAmount > 0 ? 'LONG' : 'SHORT',
                entryPrice: entryPrice,
                currentPrice: currentPrice,
                unrealizedPnl: unrealizedPnl,
                quantity: Math.abs(positionAmount)
            };

            if (existingOpenPosIndex > -1) {
                overallBotStats.currentOpenPositions[existingOpenPosIndex] = positionDetails;
            } else {
                overallBotStats.currentOpenPositions.push(positionDetails);
            }
        }

    } catch (error) {
        addLog(`Lỗi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
             addLog(`Bot dừng do lỗi API nghiêm trọng khi quản lý vị thế của ${symbol}.`);
             stopBotLogicInternal();
             if (!retryBotTimeout) {
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...');
                    await startBotLogicInternal(Array.from(configuredCoinPairs.values()).map(cfg => ({
                        symbol: cfg.symbol,
                        initialAmount: cfg.initialInvestmentAmount,
                        applyDoubleStrategy: cfg.applyDoubleStrategy
                    }))); // Truyền lại cấu hình cũ
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        }
    }
}


/**
 * Hàm chạy logic tìm kiếm cơ hội (chỉ chạy khi không có lệnh mở cho cặp đó)
 * @param {string} symbol - Symbol của cặp coin cần chạy logic
 */
async function runTradingLogic(symbol) {
    const coinConfig = configuredCoinPairs.get(symbol);

    if (!botRunning || !coinConfig) {
        addLog(`[${symbol}] Bot dừng hoặc cấu hình không tồn tại. Hủy chu kỳ quét.`);
        return;
    }

    if (coinConfig.currentOpenPosition) {
        addLog(`[${symbol}] Có vị thế mở. Bỏ qua quét mới.`);
        return;
    }

    if (coinConfig.isClosingPosition) {
        addLog(`[${symbol}] Đang trong quá trình đóng lệnh. Bỏ qua quét mới.`);
        return;
    }

    addLog(`[${symbol}] Cố gắng mở lệnh...`);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        const targetSymbol = symbol;
        let eligibleSymbol = null;

        const symbolDetails = await getSymbolDetails(targetSymbol); // getSymbolDetails có thể throw CriticalApiError
        if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
            const currentPrice = await getCurrentPrice(targetSymbol); // getCurrentPrice có thể throw CriticalApiError
            if (currentPrice === null) {
                addLog(`[${targetSymbol}] Lỗi lấy giá. Bỏ qua. Sẽ thử lại ngay.`);
            } else {
                let estimatedQuantity = (coinConfig.currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
                estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                const currentNotional = estimatedQuantity * currentPrice;

                if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                    eligibleSymbol = {
                        symbol: targetSymbol,
                        maxLeverage: symbolDetails.maxLeverage
                    };
                } else {
                    addLog(`[${targetSymbol}] KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh (minNotional/minQty). Sẽ thử lại ngay.`);
                }
            }
        } else {
            addLog(`[${targetSymbol}] Không có đòn bẩy hợp lệ hoặc không tìm thấy symbol. Sẽ thử lại ngay.`);
        }

        if (availableBalance < coinConfig.currentInvestmentAmount) {
            addLog(`[${targetSymbol}] Số dư USDT (${availableBalance.toFixed(2)}) không đủ để mở lệnh (${coinConfig.currentInvestmentAmount.toFixed(2)} USDT). Trở về lệnh ban đầu.`);
            coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
            coinConfig.consecutiveLossCount = 0;
            addLog(`[${targetSymbol}] Số dư không đủ. Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${coinConfig.nextTradeDirection}.`);
            if(botRunning) scheduleNextMainCycle(symbol); // Schedule lại ngay lập tức
            return;
        }

        if (eligibleSymbol) {
            addLog(`\n[${eligibleSymbol.symbol}] Chọn: ${eligibleSymbol.symbol}`);
            addLog(`[${eligibleSymbol.symbol}] + Đòn bẩy: ${eligibleSymbol.maxLeverage}x | Vốn: ${coinConfig.currentInvestmentAmount.toFixed(2)} USDT`);
            addLog(`[${eligibleSymbol.symbol}] Mở lệnh ${coinConfig.nextTradeDirection} ngay lập tức.`);

            await openPosition(eligibleSymbol.symbol, coinConfig.nextTradeDirection, availableBalance, eligibleSymbol.maxLeverage);

        } else {
            addLog(`[${targetSymbol}] Không thể mở lệnh ${coinConfig.nextTradeDirection}. Sẽ thử lại ngay.`);
            if(botRunning) scheduleNextMainCycle(symbol); // Schedule lại ngay lập tức
        }
    } catch (error) {
        addLog(`Lỗi trong chu kỳ giao dịch của ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API lặp lại. Tự động thử lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
            stopBotLogicInternal();
            if (!retryBotTimeout) {
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...');
                    await startBotLogicInternal(Array.from(configuredCoinPairs.values()).map(cfg => ({
                        symbol: cfg.symbol,
                        initialAmount: cfg.initialInvestmentAmount,
                        applyDoubleStrategy: cfg.applyDoubleStrategy
                    })));
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else {
            if(botRunning) scheduleNextMainCycle(symbol); // Schedule lại ngay lập tức cho các lỗi không nghiêm trọng
        }
    }
}

/**
 * Hàm lên lịch chu kỳ chính của bot (chạy ngay lập tức) cho từng cặp coin.
 * @param {string} symbol Symbol của cặp coin cần lên lịch.
 */
async function scheduleNextMainCycle(symbol) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!botRunning || !coinConfig) {
        addLog(`[${symbol}] Bot dừng hoặc cấu hình không tồn tại. Không lên lịch chu kỳ mới.`);
        if (coinConfig?.nextScheduledCycleTimeout) {
            clearTimeout(coinConfig.nextScheduledCycleTimeout);
            coinConfig.nextScheduledCycleTimeout = null;
        }
        return;
    }

    if (coinConfig.currentOpenPosition || coinConfig.isClosingPosition) {
        addLog(`[${symbol}] Có vị thế mở hoặc đang đóng. Chờ.`);
        return;
    }

    // Xóa bất kỳ lịch trình cũ nào
    if (coinConfig.nextScheduledCycleTimeout) {
        clearTimeout(coinConfig.nextScheduledCycleTimeout);
        coinConfig.nextScheduledCycleTimeout = null;
    }

    // Chạy logic ngay lập tức (không có độ trễ)
    // Nếu runTradingLogic không mở được lệnh, nó sẽ tự động schedule lại chính nó
    await runTradingLogic(symbol);
}


/**
 * Hàm mở lệnh (Long hoặc Short) và đặt TP/SL.
 * @param {string} symbol
 * @param {string} tradeDirection 'LONG' hoặc 'SHORT'
 * @param {number} usdtBalance Số dư USDT khả dụng
 * @param {number} maxLeverage Đòn bẩy tối đa cho symbol
 */
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!coinConfig || coinConfig.currentOpenPosition || coinConfig.isClosingPosition) {
        addLog(`[${symbol}] Đã có vị thế mở hoặc đang đóng lệnh. Bỏ qua mở lệnh mới.`);
        if(botRunning) scheduleNextMainCycle(symbol);
        return;
    }

    addLog(`[${symbol}] Mở ${tradeDirection}.`);
    addLog(`[${symbol}] Mở lệnh với số vốn: ${coinConfig.currentInvestmentAmount} USDT.`);
    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`[${symbol}] Lỗi lấy chi tiết symbol. Không mở lệnh.`);
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }

        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`[${symbol}] Lỗi đặt đòn bẩy ${maxLeverage}x. Hủy mở lệnh.`);
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`[${symbol}] Lỗi lấy giá hiện tại. Không mở lệnh.`);
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }
        addLog(`[${symbol}] Giá tại thời điểm gửi lệnh: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = coinConfig.currentInvestmentAmount;

        if (usdtBalance < capitalToUse) {
            addLog(`[${symbol}] Số dư USDT (${usdtBalance.toFixed(2)}) không đủ để mở lệnh (${capitalToUse.toFixed(2)}). Trở về lệnh ban đầu.`);
            coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
            coinConfig.consecutiveLossCount = 0;
            addLog(`[${symbol}] Số dư không đủ. Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo vẫn là: ${coinConfig.nextTradeDirection}.`);
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        if (quantity < minQty) {
            addLog(`[${symbol}] Qty (${quantity.toFixed(quantityPrecision)}) < minQty (${minQty}). Hủy.`);
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`[${symbol}] Notional (${currentNotional.toFixed(pricePrecision)}) < minNotional (${minNotional}). Hủy.`);
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }
        if (quantity <= 0) {
            addLog(`[${symbol}] Qty là ${quantity}. Không hợp lệ. Hủy.`);
            if(botRunning) scheduleNextMainCycle(symbol);
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

        addLog(`[${symbol}] Đã gửi lệnh MARKET để mở ${tradeDirection}.`);

        // --- ĐỢI VỊ THẾ XUẤT HIỆN TRÊN BINANCE (Quan trọng để lấy entryPrice chính xác) ---
        addLog(`[${symbol}] Đang chờ vị thế mở xuất hiện trên Binance... (Chờ vô cực)`);
        let openPositionOnBinance = null;
        const checkOpenPosIntervalMs = 500;
        let openPosAttempts = 0;

        while (!openPositionOnBinance && botRunning) {
            openPosAttempts++;
            try {
                const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
                openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
                if (!openPositionOnBinance) {
                    addLog(`[${symbol}] Chưa thấy vị thế mở. Đang chờ... (Lần ${openPosAttempts})`);
                    await sleep(checkOpenPosIntervalMs);
                }
            } catch (error) {
                addLog(`[${symbol}] Lỗi khi kiểm tra vị thế mở: ${error.msg || error.message}.`);
                await sleep(checkOpenPosIntervalMs);
                if (error instanceof CriticalApiError) throw error;
            }
        }

        if (!openPositionOnBinance) {
            addLog(`[${symbol}] LỖI NGHIÊM TRỌNG: Không tìm thấy vị thế mở sau nhiều lần thử. Có thể lệnh không khớp hoặc đã đóng ngay lập tức. Hủy chu kỳ.`);
            await cancelOpenOrdersForSymbol(symbol); // Hủy các lệnh chờ khác để làm sạch
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt));
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now()));
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`[${symbol}] Đã mở ${tradeDirection} lúc ${formattedOpenTime}`);
        addLog(`[${symbol}] + Đòn bẩy: ${maxLeverage}x`);
        addLog(`[${symbol}] + Ký quỹ: ${capitalToUse.toFixed(2)} USDT | Qty thực tế: ${actualQuantity} | Giá vào thực tế: ${entryPrice.toFixed(pricePrecision)}`);

        // --- ĐẶT LỆNH TAKE PROFIT VÀ STOP LOSS NGAY LẬP TỨC SAU KHI MỞ LỆNH ---
        // PnL cho TP/SL được tính dựa trên vốn ban đầu
        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_PERCENTAGE_MAIN;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_PERCENTAGE_MAIN;

        // Tính toán giá TP/SL
        let tpPrice, slPrice;
        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        if (tradeDirection === 'LONG') {
            tpPrice = entryPrice + priceChangeForTP;
            slPrice = entryPrice - priceChangeForSL;
        } else { // SHORT
            tpPrice = entryPrice - priceChangeForTP;
            slPrice = entryPrice + priceChangeForSL;
        }

        // Làm tròn giá TP/SL theo pricePrecision và tickSize của symbol
        tpPrice = Math.round(tpPrice / tickSize) * tickSize;
        slPrice = Math.round(slPrice / tickSize) * tickSize;
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));
        slPrice = parseFloat(slPrice.toFixed(pricePrecision));

        const tpOrderSide = (tradeDirection === 'LONG') ? 'SELL' : 'BUY';
        const slOrderSide = (tradeDirection === 'LONG') ? 'SELL' : 'BUY';

        // Đảm bảo không còn lệnh chờ nào từ trước khi đặt lệnh mới
        await cancelOpenOrdersForSymbol(symbol);
        addLog(`[${symbol}] Đã hủy các lệnh chờ cũ (nếu có).`);

        // Gửi lệnh Take Profit (TAKE_PROFIT_MARKET)
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: tpOrderSide,
                type: 'TAKE_PROFIT_MARKET',
                quantity: actualQuantity,
                stopPrice: tpPrice, // stopPrice cho lệnh TAKE_PROFIT_MARKET là giá kích hoạt
                closePosition: 'true', // Đóng toàn bộ vị thế
                newOrderRespType: 'FULL'
            });
            addLog(`[${symbol}] Đã đặt TP: ${tpPrice.toFixed(pricePrecision)}`);
        } catch (tpError) {
            addLog(`[${symbol}] Lỗi đặt TP: ${tpError.msg || tpError.message}. Tiếp tục.`);
        }

        // Gửi lệnh Stop Loss (STOP_MARKET)
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: slOrderSide,
                type: 'STOP_MARKET',
                quantity: actualQuantity,
                stopPrice: slPrice, // stopPrice cho lệnh STOP_MARKET là giá kích hoạt
                closePosition: 'true', // Đóng toàn bộ vị thế
                newOrderRespType: 'FULL'
            });
            addLog(`[${symbol}] Đã đặt SL: ${slPrice.toFixed(pricePrecision)}`);
        } catch (slError) {
            addLog(`[${symbol}] Lỗi đặt SL: ${slError.msg || slError.message}. Tiếp tục.`);
        }

        // Ghi lại thông tin vị thế mở, bao gồm giá TP/SL ban đầu
        coinConfig.currentOpenPosition = {
            symbol: symbol,
            quantity: actualQuantity,
            entryPrice: entryPrice,
            initialMargin: capitalToUse,
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection,
            initialTPPrice: tpPrice, // Lưu lại để hiển thị
            initialSLPrice: slPrice  // Lưu lại để hiển thị
        };

        // Bắt đầu kiểm tra vị thế định kỳ cho cặp này
        if(!coinConfig.positionCheckInterval) {
            coinConfig.positionCheckInterval = setInterval(async () => {
                if (botRunning && coinConfig.currentOpenPosition) {
                    try {
                        await manageOpenPosition(symbol);
                    } catch (error) {
                        addLog(`Lỗi kiểm tra vị thế định kỳ cho ${symbol}: ${error.msg || error.message}.`);
                    }
                } else if (!botRunning && coinConfig.positionCheckInterval) {
                    clearInterval(coinConfig.positionCheckInterval);
                    coinConfig.positionCheckInterval = null;
                }
            }, 300); // Kiểm tra mỗi 300ms
        }

    } catch (error) {
        addLog(`Lỗi mở ${tradeDirection} ${symbol}: ${error.msg || error.message}`);
        if(error instanceof CriticalApiError) {
            addLog(`Bot dừng do lỗi API nghiêm trọng khi mở lệnh.`);
            stopBotLogicInternal();
            if (!retryBotTimeout) {
                addLog(`Lên lịch tự động khởi động lại sau ${ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    addLog('Thử khởi động lại bot...');
                    await startBotLogicInternal(Array.from(configuredCoinPairs.values()).map(cfg => ({
                        symbol: cfg.symbol,
                        initialAmount: cfg.initialInvestmentAmount,
                        applyDoubleStrategy: cfg.applyDoubleStrategy
                    })));
                    retryBotTimeout = null;
                }, ERROR_RETRY_DELAY_MS);
            }
        } else if(botRunning) {
            scheduleNextMainCycle(symbol);
        }
    }
}

// Hàm khởi động logic bot
async function startBotLogicInternal(configs) {
    if (botRunning) {
        addLog('Bot đang chạy.');
        return 'Bot đang chạy.';
    }

    if (!API_KEY || !SECRET_KEY) {
        addLog('Lỗi: API Key hoặc Secret Key chưa được cấu hình.');
        return 'Lỗi: API Key hoặc Secret Key chưa được cấu hình.';
    }

    if (!configs || configs.length === 0) {
        addLog('Lỗi: Chưa có cặp coin nào được cấu hình.');
        return 'Lỗi: Chưa có cặp coin nào được cấu hình.';
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

        consecutiveApiErrors = 0; // Đặt lại sau khi xác minh API thành công

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('Lỗi tải exchangeInfo. Bot dừng.');
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        // Khởi tạo/cập nhật trạng thái cho từng cặp coin
        const newConfiguredCoinPairs = new Map();
        configs.forEach(cfg => {
            const existingConfig = configuredCoinPairs.get(cfg.symbol);
            newConfiguredCoinPairs.set(cfg.symbol, {
                symbol: cfg.symbol,
                initialInvestmentAmount: parseFloat(cfg.initialAmount),
                applyDoubleStrategy: !!cfg.applyDoubleStrategy,
                currentInvestmentAmount: existingConfig?.currentInvestmentAmount || parseFloat(cfg.initialAmount),
                consecutiveLossCount: existingConfig?.consecutiveLossCount || 0,
                nextTradeDirection: existingConfig?.nextTradeDirection || 'SHORT', // Mặc định SHORT khi khởi động nếu chưa có
                currentOpenPosition: existingConfig?.currentOpenPosition || null,
                positionCheckInterval: null, // Sẽ thiết lập lại khi mở lệnh
                nextScheduledCycleTimeout: null,
                isClosingPosition: false
            });
            addLog(`Cấu hình cho ${cfg.symbol}: Vốn: ${cfg.initialAmount}, x2: ${cfg.applyDoubleStrategy ? 'Bật' : 'Tắt'}. Trạng thái hiện tại: Vốn ${newConfiguredCoinPairs.get(cfg.symbol).currentInvestmentAmount.toFixed(2)}, Thua liên tiếp ${newConfiguredCoinPairs.get(cfg.symbol).consecutiveLossCount}, Chiều tiếp theo ${newConfiguredCoinPairs.get(cfg.symbol).nextTradeDirection}.`);
        });
        configuredCoinPairs.clear();
        newConfiguredCoinPairs.forEach((value, key) => configuredCoinPairs.set(key, value));


        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Tổng số cặp coin đang theo dõi: ${configuredCoinPairs.size}.`);

        // Bắt đầu chu kỳ trading cho từng cặp coin
        for (const symbol of configuredCoinPairs.keys()) {
            const coinConfig = configuredCoinPairs.get(symbol);
            if (coinConfig.currentOpenPosition) {
                addLog(`[${symbol}] Bot khởi động lại và tìm thấy vị thế mở. Bắt đầu quản lý vị thế.`);
                if (!coinConfig.positionCheckInterval) {
                     coinConfig.positionCheckInterval = setInterval(async () => {
                         if (botRunning && coinConfig.currentOpenPosition) {
                             try {
                                 await manageOpenPosition(symbol);
                             } catch (error) {
                                 addLog(`Lỗi kiểm tra vị thế định kỳ cho ${symbol}: ${error.msg || error.message}.`);
                             }
                         } else if (!botRunning && coinConfig.positionCheckInterval) {
                             clearInterval(coinConfig.positionCheckInterval);
                             coinConfig.positionCheckInterval = null;
                         }
                     }, 300); // Kiểm tra mỗi 300ms
                 }
            } else {
                scheduleNextMainCycle(symbol);
            }
        }

        // Cập nhật overallBotStats ban đầu
        overallBotStats = {
            totalProfit: 0,
            totalLoss: 0,
            netPNL: 0,
            currentOpenPositions: []
        };


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
                await startBotLogicInternal(configs);
                retryBotTimeout = null;
            }, ERROR_RETRY_DELAY_MS);
        }
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

// Hàm dừng logic bot
function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot không chạy.');
        return 'Bot không chạy.';
    }
    botRunning = false;

    // Dừng tất cả các interval/timeout cho từng cặp coin
    configuredCoinPairs.forEach(coinConfig => {
        if (coinConfig.nextScheduledCycleTimeout) {
            clearTimeout(coinConfig.nextScheduledCycleTimeout);
            coinConfig.nextScheduledCycleTimeout = null;
        }
        if (coinConfig.positionCheckInterval) {
            clearInterval(coinConfig.positionCheckInterval);
            coinConfig.positionCheckInterval = null;
        }
        // Đảm bảo cờ isClosingPosition được reset khi bot dừng
        coinConfig.isClosingPosition = false;
    });

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

// Endpoint để cấu hình các tham số từ frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinConfigs } = req.body;

    API_KEY = apiKey.trim();
    SECRET_KEY = secretKey.trim();

    // Cập nhật configuredCoinPairs Map. Giữ lại trạng thái cũ nếu có thể.
    const newConfiguredCoinPairs = new Map();
    coinConfigs.forEach(cfg => {
        const existingConfig = configuredCoinPairs.get(cfg.symbol);
        newConfiguredCoinPairs.set(cfg.symbol, {
            symbol: cfg.symbol,
            initialInvestmentAmount: parseFloat(cfg.initialAmount),
            applyDoubleStrategy: !!cfg.applyDoubleStrategy,
            currentInvestmentAmount: existingConfig?.currentInvestmentAmount || parseFloat(cfg.initialAmount),
            consecutiveLossCount: existingConfig?.consecutiveLossCount || 0,
            nextTradeDirection: existingConfig?.nextTradeDirection || 'SHORT', // Mặc định SHORT khi khởi động nếu chưa có
            currentOpenPosition: existingConfig?.currentOpenPosition || null,
            positionCheckInterval: existingConfig?.positionCheckInterval || null,
            nextScheduledCycleTimeout: existingConfig?.nextScheduledCycleTimeout || null,
            isClosingPosition: existingConfig?.isClosingPosition || false
        });
    });
    configuredCoinPairs.clear();
    newConfiguredCoinPairs.forEach((value, key) => configuredCoinPairs.set(key, value));


    addLog(`Đã cập nhật cấu hình:`);
    addLog(`  API Key: ${API_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Secret Key: ${SECRET_KEY ? 'Đã thiết lập' : 'Chưa thiết lập'}`);
    addLog(`  Cấu hình cho ${configuredCoinPairs.size} cặp coin.`);

    res.json({ success: true, message: 'Cấu hình đã được cập nhật.' });
});

// Endpoint để frontend lấy thống kê tổng thể của bot
app.get('/api/bot_stats', (req, res) => {
    // Cập nhật overallBotStats.currentOpenPositions từ các coinConfig
    overallBotStats.currentOpenPositions = [];
    configuredCoinPairs.forEach(coinConfig => {
        if (coinConfig.currentOpenPosition) {
            overallBotStats.currentOpenPositions.push({
                symbol: coinConfig.currentOpenPosition.symbol,
                side: coinConfig.currentOpenPosition.side,
                entryPrice: coinConfig.currentOpenPosition.entryPrice,
                unrealizedPnl: coinConfig.currentOpenPosition.unrealizedPnl || 0,
                quantity: coinConfig.currentOpenPosition.quantity,
                initialTPPrice: coinConfig.currentOpenPosition.initialTPPrice, // Thêm để hiển thị
                initialSLPrice: coinConfig.currentOpenPosition.initialSLPrice  // Thêm để hiển thị
            });
        }
    });

    res.json({
        success: true,
        data: overallBotStats
    });
});


app.get('/start_bot_logic', async (req, res) => {
    // Khi khởi động, cần truyền cấu hình hiện tại của các cặp coin
    const configsToStart = Array.from(configuredCoinPairs.values()).map(cfg => ({
        symbol: cfg.symbol,
        initialAmount: cfg.initialInvestmentAmount,
        applyDoubleStrategy: cfg.applyDoubleStrategy
    }));
    const message = await startBotLogicInternal(configsToStart);
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
