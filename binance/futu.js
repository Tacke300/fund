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
let isClosingPosition = false; // Nên là một Map để xử lý nhiều symbol nếu cần

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động

// THAY ĐỔI LỚN: Quản lý trạng thái cho TỪNG CẶP COIN
// Thay vì biến toàn cục, dùng Map để lưu trạng thái của mỗi cặp coin
const configuredCoinPairs = new Map(); // Map<symbol, { initialInvestmentAmount, applyDoubleStrategy, currentInvestmentAmount, consecutiveLossCount, nextTradeDirection, currentOpenPosition, positionCheckInterval, nextScheduledCycleTimeout }>

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
// const INITIAL_INVESTMENT_AMOUNT_DEFAULT = 10;
// const APPLY_DOUBLE_STRATEGY_DEFAULT = false;

// Cấu hình Take Profit & Stop Loss (áp dụng chung cho tất cả các cặp)
const TAKE_PROFIT_PERCENTAGE_MAIN = 255; // 2.2% lãi trên VỐN
const STOP_LOSS_PERCENTAGE_MAIN = 97;   // 0.9% lỗ trên VỐN

// Số lần thua liên tiếp tối đa trước khi reset về lệnh ban đầu
const MAX_CONSECUTIVE_LOSSES = 5;

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
        }
    }
}

// Hàm chờ một khoảng thời gian
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Hàm đóng vị thế và xác định lý do đóng (TP/SL/Khác)
 * @param {string} symbol
 * @param {number} quantity
 * @param {string} reason Lý do ban đầu (ví dụ: 'Kiểm tra vị thế', 'Lỗi', 'Thủ công')
 */
async function closePosition(symbol, quantity, reason) {
    // Sử dụng một cờ riêng cho từng symbol nếu có nhiều symbol
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!coinConfig || coinConfig.isClosingPosition) { // Thêm cờ isClosingPosition vào coinConfig
        addLog(`Đang trong quá trình đóng lệnh hoặc không tìm thấy cấu hình cho ${symbol}. Bỏ qua yêu cầu đóng lệnh mới.`);
        return;
    }
    coinConfig.isClosingPosition = true; // Đặt cờ cho symbol này

    // Lưu lại thông tin vị thế trước khi đóng để đối chiếu
    const positionSideBeforeClose = coinConfig.currentOpenPosition?.side;
    const entryPriceBeforeClose = coinConfig.currentOpenPosition?.entryPrice;
    const initialTPPriceBeforeClose = coinConfig.currentOpenPosition?.initialTPPrice;
    const initialSLPriceBeforeClose = coinConfig.currentOpenPosition?.initialSLPrice;
    const initialMarginBeforeClose = coinConfig.currentOpenPosition?.initialMargin; // Vốn ban đầu của lệnh đó

    addLog(`Đóng lệnh ${positionSideBeforeClose || 'UNKNOWN'} ${symbol} (Lý do: ${reason}). Qty: ${quantity}.`);
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`Lỗi lấy symbol info ${symbol}. Không đóng lệnh.`);
            coinConfig.isClosingPosition = false; // Reset cờ
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;

        // --- BƯỚC 1: KIỂM TRA VỊ THẾ HIỆN TẠI TRÊN BINANCE ---
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`${symbol} đã đóng trên sàn hoặc không có vị thế trước khi bot kịp gửi lệnh đóng MARKET. Lý do: ${reason}.`);
        } else {
            const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

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

        // --- BƯỚC 2: ĐỢI VỊ THẾ ĐƯỢC CẬP NHẬT HOÀN TOÀN TRÊN BINANCE ---
        await sleep(750); // Tăng lên 0.75s để đảm bảo Binance kịp xử lý
        addLog(`Đã đợi 0.75 giây sau khi gửi lệnh đóng. Đang xác minh vị thế và tìm giao dịch trên Binance.`);

        // --- BƯỚC 3: XÁC MINH VỊ THẾ VÀ LẤY PNL CHÍNH XÁC ---
        const finalPositions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const finalPositionOnBinance = finalPositions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        let finalPnlReason = reason; // Lý do mặc định
        let pnlValue = 0;
        let closePrice = 0; // Giá đóng lệnh thực tế

        if (!finalPositionOnBinance || parseFloat(finalPositionOnBinance.positionAmt) === 0) {
            addLog(`Xác nhận: Vị thế ${symbol} đã đóng hoàn toàn trên Binance. Đang tìm giao dịch đóng.`);

            const startTime = Date.now() - 2 * 60 * 1000; // 2 phút trước
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', {
                symbol: symbol,
                limit: 50,
                startTime: startTime
            });

            const latestClosingTrade = recentTrades.find(t => {
                const tradeQty = parseFloat(t.qty);
                const tradeSide = t.side;

                const isMatchingLongClose = (positionSideBeforeClose === 'LONG' && tradeSide === 'SELL' && Math.abs(tradeQty - quantity) < 0.000001);
                const isMatchingShortClose = (positionSideBeforeClose === 'SHORT' && tradeSide === 'BUY' && Math.abs(tradeQty - quantity) < 0.000001);

                return (isMatchingLongClose || isMatchingShortClose);
            });

            if (latestClosingTrade) {
                closePrice = parseFloat(latestClosingTrade.price);
                if (entryPriceBeforeClose) {
                    pnlValue = (positionSideBeforeClose === 'LONG')
                        ? (closePrice - entryPriceBeforeClose) * quantity
                        : (entryPriceBeforeClose - closePrice) * quantity;
                } else {
                    addLog(`Cảnh báo: Không có entryPriceBeforeClose cho ${symbol} để tính PNL chính xác. PNL sẽ là 0.`);
                }

                // --- BƯỚC 4: XÁC ĐỊNH LÝ DO ĐÓNG TP/SL DỰA TRÊN GIÁ KHỚP ---
                const priceDiffTP = Math.abs(closePrice - initialTPPriceBeforeClose);
                const priceDiffSL = Math.abs(closePrice - initialSLPriceBeforeClose);
                const tickSize = symbolInfo.tickSize;
                const tolerance = tickSize * 2.5;

                if (initialTPPriceBeforeClose && priceDiffTP <= tolerance) {
                    finalPnlReason = "TP khớp trên Binance";
                } else if (initialSLPriceBeforeClose && priceDiffSL <= tolerance) {
                    finalPnlReason = "SL khớp trên Binance";
                } else if (reason.includes('kích hoạt ngay')) {
                    finalPnlReason = "Lệnh đối ứng kích hoạt ngay (thường là SL/TP)";
                } else {
                    finalPnlReason = `Đóng do lý do khác (hoặc thủ công): ${reason}`;
                }
            } else {
                 addLog(`Không tìm thấy giao dịch đóng lệnh gần nhất cho ${symbol} (Qty: ${quantity}, Side: ${positionSideBeforeClose}) để xác định TP/SL chính xác. Lý do sẽ được giữ nguyên.`);
                 pnlValue = 0;
            }
        } else {
            addLog(`Cảnh báo: Vị thế ${symbol} vẫn còn mở (${finalPositionOnBinance.positionAmt}) sau khi đóng lệnh. Sẽ cố gắng đóng lại.`);
            coinConfig.isClosingPosition = false; // Reset cờ để có thể đóng lại
            await closePosition(symbol, Math.abs(parseFloat(finalPositionOnBinance.positionAmt)), 'Vị thế sót sau đóng');
            return;
        }

        // --- BƯỚC 5: CẬP NHẬT TỔNG LỜI/LỖ TOÀN BỘ BOT ---
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
            `├─ PNL: ${pnlValue.toFixed(2)} USDT`,
            `├─ Tổng Lời Bot: ${overallBotStats.totalProfit.toFixed(2)} USDT`,
            `├─ Tổng Lỗ Bot: ${overallBotStats.totalLoss.toFixed(2)} USDT`,
            `└─ PNL Ròng Bot: ${overallBotStats.netPNL.toFixed(2)} USDT`
        ].join('\n'));

        // --- BƯỚC 6: XỬ LÝ LOGIC RIÊNG CHO TỪNG CẶP COIN ---
        if (finalPnlReason.includes('TP')) {
            coinConfig.consecutiveLossCount = 0;
            coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
            coinConfig.nextTradeDirection = positionSideBeforeClose;
            addLog(`Đã đạt TP cho ${symbol}. Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${coinConfig.nextTradeDirection}.`);
        } else if (finalPnlReason.includes('SL') || finalPnlReason.includes('Hết thời gian') || finalPnlReason.includes('kích hoạt ngay')) {
            if (coinConfig.applyDoubleStrategy) {
                coinConfig.consecutiveLossCount++;
                addLog(`Đã chạm SL hoặc hết thời gian cho ${symbol}. Số lần lỗ liên tiếp: ${coinConfig.consecutiveLossCount}.`);
                if (coinConfig.consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                    coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
                    coinConfig.consecutiveLossCount = 0;
                    addLog(`Đã lỗ ${MAX_CONSECUTIVE_LOSSES} lần liên tiếp cho ${symbol}. Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0.`);
                } else {
                    coinConfig.currentInvestmentAmount *= 2;
                    addLog(`Gấp đôi vốn cho lệnh tiếp theo của ${symbol}: ${coinConfig.currentInvestmentAmount} USDT.`);
                }
            } else {
                 addLog(`Đã chạm SL hoặc hết thời gian cho ${symbol}. Không áp dụng chiến lược x2 vốn.`);
                 coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
                 coinConfig.consecutiveLossCount = 0;
            }
            coinConfig.nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG');
            addLog(`Lệnh tiếp theo của ${symbol}: ${coinConfig.nextTradeDirection}.`);
        } else {
            coinConfig.currentInvestmentAmount = coinConfig.initialInvestmentAmount;
            coinConfig.consecutiveLossCount = 0;
            coinConfig.nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG');
            addLog(`Lệnh đóng do lý do đặc biệt (${finalPnlReason}) cho ${symbol}. Reset vốn về ${coinConfig.currentInvestmentAmount} USDT và lượt lỗ về 0. Lệnh tiếp theo: ${coinConfig.nextTradeDirection}.`);
        }

        // --- BƯỚC 7: DỌN DẸP TRẠNG THÁI CHO CẶP COIN NÀY ---
        coinConfig.currentOpenPosition = null;
        if (coinConfig.positionCheckInterval) {
            clearInterval(coinConfig.positionCheckInterval);
            coinConfig.positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol);
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
 * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP)
 * @param {string} symbol - Symbol của cặp coin cần quản lý
 */
async function manageOpenPosition(symbol) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!coinConfig || !coinConfig.currentOpenPosition || coinConfig.isClosingPosition) {
        if (!coinConfig?.currentOpenPosition && coinConfig?.positionCheckInterval) {
            clearInterval(coinConfig.positionCheckInterval);
            coinConfig.positionCheckInterval = null;
            if(botRunning) scheduleNextMainCycle(symbol); // Kích hoạt chu kỳ mới nếu không còn vị thế
        }
        return;
    }

    const { quantity } = coinConfig.currentOpenPosition;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`Vị thế ${symbol} đã đóng trên sàn. Đang cập nhật bot.`);
            // Gọi closePosition với lý do chung, sau đó hàm closePosition sẽ tự xác minh lại
            await closePosition(symbol, quantity, "đã đóng trên sàn");
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
        addLog(`Bot dừng hoặc cấu hình ${symbol} không tồn tại. Hủy chu kỳ quét.`);
        return;
    }

    if (coinConfig.currentOpenPosition) {
        addLog(`[${symbol}] Có vị thế mở. Bỏ qua quét mới.`);
        return;
    }

    addLog(`[${symbol}] Cố gắng mở lệnh không phanh...`);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        const targetSymbol = symbol;
        let eligibleSymbol = null;

        const symbolDetails = await getSymbolDetails(targetSymbol);
        if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
            const currentPrice = await getCurrentPrice(targetSymbol);
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
            if(botRunning) scheduleNextMainCycle(symbol);
            return;
        }

        if (eligibleSymbol) {
            addLog(`\n[${eligibleSymbol.symbol}] Chọn: ${eligibleSymbol.symbol}`);
            addLog(`[${eligibleSymbol.symbol}] + Đòn bẩy: ${eligibleSymbol.maxLeverage}x | Vốn: ${coinConfig.currentInvestmentAmount.toFixed(2)} USDT`);
            addLog(`[${eligibleSymbol.symbol}] Mở lệnh ${coinConfig.nextTradeDirection} ngay lập tức.`);

            await openPosition(eligibleSymbol.symbol, coinConfig.nextTradeDirection, availableBalance, eligibleSymbol.maxLeverage);

        } else {
            addLog(`[${targetSymbol}] Không thể mở lệnh ${coinConfig.nextTradeDirection}. Sẽ thử lại ngay.`);
            if(botRunning) scheduleNextMainCycle(symbol);
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
            if(botRunning) scheduleNextMainCycle(symbol);
        }
    }
}

/**
 * Hàm lên lịch chu kỳ chính của bot (đã bỏ delay) cho từng cặp coin.
 * @param {string} symbol Symbol của cặp coin cần lên lịch.
 */
async function scheduleNextMainCycle(symbol) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!botRunning || !coinConfig) {
        addLog(`Bot dừng hoặc cấu hình ${symbol} không tồn tại. Không lên lịch chu kỳ mới.`);
        if (coinConfig?.nextScheduledCycleTimeout) {
            clearTimeout(coinConfig.nextScheduledCycleTimeout);
        }
        return;
    }

    if (coinConfig.currentOpenPosition) {
        addLog(`[${symbol}] Có vị thế mở. Chờ đóng vị thế hiện tại.`);
        return;
    }

    // Xóa bất kỳ lịch trình cũ nào
    if (coinConfig.nextScheduledCycleTimeout) {
        clearTimeout(coinConfig.nextScheduledCycleTimeout);
    }

    // Chạy logic ngay lập tức
    await runTradingLogic(symbol);
}


/**
 * Hàm mở lệnh (Long hoặc Short)
 * @param {string} symbol
 * @param {string} tradeDirection 'LONG' hoặc 'SHORT'
 * @param {number} usdtBalance Số dư USDT khả dụng
 * @param {number} maxLeverage Đòn bẩy tối đa cho symbol
 */
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    const coinConfig = configuredCoinPairs.get(symbol);
    if (!coinConfig || coinConfig.currentOpenPosition) {
        addLog(`[${symbol}] Đã có vị thế mở hoặc cấu hình không tồn tại. Bỏ qua mở lệnh mới.`);
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

        await sleep(1000);
        addLog(`[${symbol}] Đã đợi 1 giây sau khi gửi lệnh mở. Đang lấy giá vào lệnh thực tế từ Binance.`);

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            addLog(`[${symbol}] Không tìm thấy vị thế mở sau 1 giây. Có thể lệnh không khớp hoặc đã đóng ngay lập tức.`);
            await cancelOpenOrdersForSymbol(symbol);
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

        await cancelOpenOrdersForSymbol(symbol);
        addLog(`[${symbol}] Đã hủy các lệnh chờ cũ (nếu có).`);

        // --- BẮT ĐẦU TÍNH TOÁN TP/SL THEO % VỐN ---
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

            slPrice = Math.max(0, Math.floor(slPrice / tickSize) * tickSize);
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize;

        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            slOrderSide = 'BUY';
            tpOrderSide = 'BUY';

            slPrice = Math.ceil(slPrice / tickSize) * tickSize;
            tpPrice = Math.max(0, Math.ceil(tpPrice / tickSize) * tickSize);
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`[${symbol}] TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

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
            addLog(`[${symbol}] Đã đặt SL @ ${slPrice.toFixed(pricePrecision)}.`);
        } catch (slError) {
            addLog(`[${symbol}] Lỗi đặt SL: ${slError.msg || slError.message}.`);
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                addLog(`[${symbol}] SL kích hoạt ngay lập tức. Đóng vị thế.`);
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
            addLog(`[${symbol}] Đã đặt TP @ ${tpPrice.toFixed(pricePrecision)}.`);
        } catch (tpError) {
            addLog(`[${symbol}] Lỗi đặt TP: ${tpError.msg || tpError.message}.`);
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                addLog(`[${symbol}] TP kích hoạt ngay lập tức. Đóng vị thế.`);
                await closePosition(symbol, actualQuantity, 'TP kích hoạt ngay');
                return;
            }
        }

        coinConfig.currentOpenPosition = {
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
        } else if(botRunning) {
            scheduleNextMainCycle(symbol);
        }
    }
}

// Hàm khởi động logic bot
async function startBotLogicInternal(configs) { // configs là một mảng cấu hình từ frontend
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
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`);

        consecutiveApiErrors = 0;

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('Lỗi tải exchangeInfo. Bot dừng.');
            botRunning = false;
            return 'Không thể tải exchangeInfo.';
        }

        // Khởi tạo/cập nhật trạng thái cho từng cặp coin
        configuredCoinPairs.clear(); // Xóa các cấu hình cũ
        configs.forEach(cfg => {
            configuredCoinPairs.set(cfg.symbol, {
                symbol: cfg.symbol,
                initialInvestmentAmount: parseFloat(cfg.initialAmount),
                applyDoubleStrategy: cfg.applyDoubleStrategy,
                currentInvestmentAmount: parseFloat(cfg.initialAmount), // Bắt đầu bằng vốn ban đầu
                consecutiveLossCount: 0,
                nextTradeDirection: 'SHORT', // Mặc định SHORT khi khởi động
                currentOpenPosition: null, // Không có vị thế mở khi khởi động
                positionCheckInterval: null,
                nextScheduledCycleTimeout: null,
                isClosingPosition: false // Cờ kiểm soát việc đóng lệnh
            });
            addLog(`Cấu hình cho ${cfg.symbol}: Vốn: ${cfg.initialAmount}, x2: ${cfg.applyDoubleStrategy ? 'Bật' : 'Tắt'}`);
        });

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`);
        addLog(`Tổng số cặp coin đang theo dõi: ${configuredCoinPairs.size}.`);

        // Bắt đầu chu kỳ trading cho từng cặp coin
        for (const symbol of configuredCoinPairs.keys()) {
            scheduleNextMainCycle(symbol);
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
                await startBotLogicInternal(configs); // Thử khởi động lại với cấu hình đã truyền
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
            // Giữ lại các trạng thái động nếu cặp coin đã tồn tại và bot đang chạy
            currentInvestmentAmount: existingConfig?.currentInvestmentAmount || parseFloat(cfg.initialAmount),
            consecutiveLossCount: existingConfig?.consecutiveLossCount || 0,
            nextTradeDirection: existingConfig?.nextTradeDirection || 'SHORT',
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
                // currentPrice và unrealizedPnl sẽ được cập nhật trong manageOpenPosition
                // hoặc bạn có thể thêm logic ở đây để tính lại nếu cần real-time data
                // Để đơn giản cho API này, chúng ta chỉ trả về dữ liệu đã có
                unrealizedPnl: coinConfig.currentOpenPosition.unrealizedPnl || 0, // Giá trị PNL đã lưu từ manageOpenPosition
                quantity: coinConfig.currentOpenPosition.quantity
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
