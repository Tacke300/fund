import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === API KEY & SECRET ===
// !!! QUAN TRỌNG: DÁN API Key và Secret Key THẬT của bạn vào đây. !!!
// Đảm bảo không có khoảng trắng thừa khi copy/paste.
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim();   // <--- THAY THẾ BẰNG API KEY THẬT CỦA BẠN
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // <--- THAY THẾ BẰNG SECRET KEY THẬT CỦA BẠN

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Giữ nguyên, nếu bạn có logic đồng bộ thời gian thì nó sẽ dùng

// Biến cache cho exchangeInfo
let exchangeInfoCache = null;

// Biến cờ để tránh việc gửi nhiều lệnh đóng cùng lúc
let isClosingPosition = false;

// Biến cờ điều khiển trạng thái bot
let botRunning = false;
let botStartTime = null;

let currentOpenPosition = null; // Biến toàn cục để theo dõi vị thế đang mở
let positionCheckInterval = null; // Biến để lưu trữ setInterval cho việc kiểm tra vị thế
let nextScheduledTimeout = null; // Biến để lưu trữ setTimeout cho lần chạy tiếp theo

// Biến cho việc hiển thị đếm ngược trên web
let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null; // Để gửi đếm ngược cho frontend

// === Cấu hình Bot ===
const MIN_USDT_BALANCE_TO_OPEN = 0.1; // Số dư USDT tối thiểu để mở lệnh (đã điều chỉnh)
const CAPITAL_PERCENTAGE_PER_TRADE = 0.15; // Phần trăm vốn sử dụng cho mỗi lệnh (50% tài khoản)

// Cấu hình TP/SL theo yêu cầu mới
const STOP_LOSS_PERCENTAGE = 1.997; // SL cố định 70% của vốn đầu tư ban đầu

// Bảng ánh xạ maxLeverage với Take Profit percentage
// Đảm bảo các giá trị đòn bẩy được định nghĩa ở đây.
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.3,
    25: 0.5,
    50: 0.7,
    75: 0.9,
    100: 0.12,
    125: 0.15,
};

// Ngưỡng funding rate âm tối thiểu để xem xét
const MIN_FUNDING_RATE_THRESHOLD = -0.005; 
const MAX_POSITION_LIFETIME_SECONDS = 150; // Thời gian tối đa giữ một vị thế (180 giây = 3 phút)

// Thời gian trước giờ funding mà bot sẽ xem xét mở lệnh (đơn vị: phút)
// Vẫn giữ cửa sổ hẹp nếu bạn chỉ muốn quét vào phút :59
const FUNDING_WINDOW_MINUTES = 1; 

// Ngưỡng thời gian còn lại (tính bằng giây) để bot coi là "sắp trả funding" và tiến hành mở lệnh.
// Vẫn giữ hẹp để phù hợp với việc quét tại phút :59
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 62; // Chỉ mở nếu còn lại <= 60 giây (tức là chỉ trong phút :59)

// Cấu hình thời điểm mở lệnh
const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; // 1 giây trước giờ funding (tức là vào giây :59 của phút :59)
const OPEN_TRADE_AFTER_SECOND_OFFSET_MS = 750; // Thêm 797ms sau khi giây là 59

// === Cấu hình Server Web ===
const WEB_SERVER_PORT = 3000; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc)
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log';
const THIS_BOT_PM2_NAME = 'bot_bina';

// Hàm addLog để ghi nhật ký (chỉ ra console)
function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    // Thêm màu sắc cho log trong console
    if (message.startsWith('✅')) {
        logEntry = `\x1b[32m${logEntry}\x1b[0m`; // Green
    } else if (message.startsWith('❌')) {
        logEntry = `\x1b[31m${logEntry}\x1b[0m`; // Red
    } else if (message.startsWith('⚠️')) {
        logEntry = `\x1b[33m${logEntry}\x1b[0m`; // Yellow
    } else if (isImportant) {
        logEntry = `\x1b[36m${logEntry}\x1b[0m`; // Cyan for important messages
    }

    console.log(logEntry);
}

// Hàm tiện ích để định dạng thời gian Date object sang string theo UTC+7
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

// Hàm delay
const delay = ms => new Promise(resolve => setTimeout(() => resolve(), ms));

// Hàm tạo chữ ký HMAC SHA256
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

// Hàm gửi HTTP request
function makeHttpRequest(method, hostname, path, headers, postData = '') {
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
                        errorDetails.msg += ` - Raw Response: ${data.substring(0, 200)}...`;
                    }
                    addLog(`❌ makeHttpRequest lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`❌ makeHttpRequest lỗi network: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

// Hàm gọi API có chữ ký
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset; // Sử dụng offset để đồng bộ thời gian

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
    } else {
        throw new Error(`Unsupported method: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        return JSON.parse(rawData);
    } catch (error) {
        addLog("❌ Lỗi khi gửi yêu cầu ký tới Binance API:");
        addLog(`  Mã lỗi: ${error.code || 'UNKNOWN'}`);
        addLog(`  Thông báo: ${error.msg || error.message || 'Lỗi không xác định'}`);
        if (error.code === -2015) {
            addLog("  Gợi ý: Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY, SECRET_KEY và quyền truy cập Futures của bạn.");
        } else if (error.code === -1021) {
            addLog("  Gợi ý: Lỗi lệch thời gian. Đảm bảo đồng hồ máy tính của bạn chính xác (sử dụng NTP) hoặc nếu vẫn gặp lỗi, hãy báo lại để chúng ta thêm cơ chế đồng bộ thời gian nâng cao.");
        } else if (error.code === -1022) {
            addLog("  Gợi ý: Lỗi chữ ký không hợp lệ. Điều này có thể do API Key/Secret bị sai, hoặc có vấn đề trong cách bạn xây dựng chuỗi tham số để ký (ví dụ: thiếu tham số, sai thứ tự, hoặc khoảng trắng không mong muốn).");
        } else if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

// Hàm gọi API công khai
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
        return JSON.parse(rawData);
    } catch (error) {
        addLog("❌ Lỗi khi gửi yêu cầu công khai tới Binance API:");
        addLog(`  Mã lỗi: ${error.code || 'UNKNOWN'}`);
        addLog(`  Thông báo: ${error.msg || error.message || 'Lỗi không xác định'}`);
        if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

// Hàm lấy thời gian server Binance
async function syncServerTime() {
try {
    const data = await callPublicAPI('/fapi/v1/time');
    const binanceServerTime = data.serverTime;
    const localTime = Date.now();
    serverTimeOffset = binanceServerTime - localTime;
    addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms.`, true);
} catch (error) {
    addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}.`, true);
    serverTimeOffset = 0; // Đặt về 0 nếu không đồng bộ được để tránh lỗi timestamp
}
}

// Hàm lấy thông tin đòn bẩy cho một symbol
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });

        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);

            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                // Lấy bracket đầu tiên cho đòn bẩy tối đa
                const firstBracket = symbolData.brackets[0];
                if (firstBracket.maxInitialLeverage !== undefined) {
                    const maxLev = parseInt(firstBracket.maxInitialLeverage);
                    return maxLev;
                } else if (firstBracket.initialLeverage !== undefined) { // Fallback cho trường hợp tên thuộc tính khác
                    const maxLev = parseInt(firstBracket.initialLeverage);
                    return maxLev;
                }
            }
        }
        addLog(`[DEBUG getLeverageBracketForSymbol] Không tìm thấy thông tin đòn bẩy hợp lệ cho ${symbol} từ response.`);
        return null;
    } catch (error) {
        addLog(`❌ Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// NEW: Hàm thiết lập đòn bẩy cho một symbol
async function setLeverage(symbol, leverage) {
    try {
        addLog(`[DEBUG] Đang thiết lập đòn bẩy ${leverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        });
        addLog(`✅ Đã thiết lập đòn bẩy ${leverage}x cho ${symbol}.`);
        return true;
    } catch (error) {
        addLog(`❌ Lỗi khi thiết lập đòn bẩy ${leverage}x cho ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}

// Hàm lấy thông tin sàn (exchangeInfo)
async function getExchangeInfo() {
if (exchangeInfoCache) {
    return exchangeInfoCache;
}

addLog('>>> Đang lấy exchangeInfo từ Binance...', true);
try {
    const data = await callPublicAPI('/fapi/v1/exchangeInfo');
    addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`, true);

    exchangeInfoCache = {};
    data.symbols.forEach(s => {
    // Tìm các bộ lọc cần thiết
    const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
    const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
    const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

    exchangeInfoCache[s.symbol] = {
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
        maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.maxQty) : Infinity),
        stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
        minPrice: priceFilter ? parseFloat(priceFilter.minPrice) : 0,
        maxPrice: priceFilter ? parseFloat(priceFilter.maxPrice) : Infinity,
        tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
    };
    });
    addLog('>>> Đã tải thông tin sàn và cache.', true);
    return exchangeInfoCache;
} catch (error) {
    addLog('❌ Lỗi khi lấy exchangeInfo: ' + (error.msg || error.message), true);
    exchangeInfoCache = null;
    return null;
}
}

// Hàm kết hợp để lấy tất cả filters và maxLeverage
async function getSymbolFiltersAndMaxLeverage(symbol) {
const filters = await getExchangeInfo();

if (!filters || !filters[symbol]) {
    addLog(`[DEBUG getSymbolFiltersAndMaxLeverage] Không tìm thấy filters cho ${symbol}.`);
    return null;
}

const maxLeverage = await getLeverageBracketForSymbol(symbol);

return {
    ...filters[symbol],
    maxLeverage: maxLeverage
};
}

// Hàm lấy giá hiện tại
async function getCurrentPrice(symbol) {
try {
    const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
    const price = parseFloat(data.price);
    return price;
} catch (error) {
    // Không in log lỗi ở đây nếu lỗi thường xuyên (ví dụ: mất mạng tạm thời)
    // addLog(`❌ Lỗi khi lấy giá cho ${symbol}: ` + (error.msg || error.message));
    return null;
}
}

// --- Hàm chính để đóng lệnh Short ---
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) return; // Đang đóng lệnh, không làm gì thêm
    isClosingPosition = true; // Đặt cờ

    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol} với khối lượng ${quantityToClose}. Lý do: ${reason}.`);
    try {
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo) {
            addLog(`❌ Không thể lấy thông tin symbol cho ${symbol} để đóng lệnh.`);
            isClosingPosition = false;
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        const adjustedQuantity = parseFloat(quantityToClose.toFixed(quantityPrecision));

        // Kiểm tra vị thế thực tế trên Binance để đảm bảo chúng ta chỉ đóng nếu có vị thế
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> Không có vị thế SHORT để đóng cho ${symbol} hoặc đã đóng trên sàn.`, true);
            currentOpenPosition = null;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
                positionCheckInterval = null;
            }
            isClosingPosition = false;
            stopCountdownFrontend(); // Dừng đếm ngược trên frontend
            if(botRunning) scheduleNextMainCycle(); // Lên lịch cho lần quét tiếp theo nếu bot đang chạy
            return;
        }

        // Gửi lệnh đóng
        addLog(`[DEBUG] Gửi lệnh đóng SHORT: symbol=${symbol}, side=BUY, type=MARKET, quantity=${adjustedQuantity}, reduceOnly=true`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY', // Để đóng lệnh SHORT, cần lệnh BUY
            type: 'MARKET',
            quantity: adjustedQuantity,
            reduceOnly: 'true' // Đảm bảo lệnh này chỉ để giảm vị thế
        });

        addLog(`✅ Đã đóng vị thế SHORT ${symbol}.`, true);
        currentOpenPosition = null;
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
            positionCheckInterval = null;
        }
        isClosingPosition = false;
        stopCountdownFrontend(); // Dừng đếm ngược trên frontend
        if(botRunning) scheduleNextMainCycle(); // Lên lịch cho lần quét tiếp theo nếu bot đang chạy

    } catch (error) {
        addLog(`❌ Lỗi đóng lệnh SHORT ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false; // Xóa cờ ngay cả khi có lỗi để thử lại
    }
}

// Hàm khởi tạo và chạy bộ đếm ngược cho frontend
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
                currentCountdownMessage = `Vị thế ${currentOpenPosition.symbol}: Đang mở, còn lại ${timeLeft} giây.`;
            } else {
                currentCountdownMessage = `Vị thế ${currentOpenPosition.symbol}: Đã vượt quá thời gian tối đa. Đang chờ đóng.`;
            }
        } else {
            stopCountdownFrontend();
        }
    }, 1000); // Cập nhật mỗi giây
}

// Hàm dừng bộ đếm ngược cho frontend
function stopCountdownFrontend() {
    if (countdownIntervalFrontend) {
        clearInterval(countdownIntervalFrontend);
        countdownIntervalFrontend = null;
    }
    currentCountdownMessage = "Không có lệnh đang chờ đóng.";
}

// --- Hàm chính để mở lệnh Short ---
async function openShortPosition(symbol, fundingRate, usdtBalance, maxLeverage) { // *** THÊM THAM SỐ maxLeverage ***
    if (currentOpenPosition) {
        addLog(`⚠️ Đã có vị thế đang mở (${currentOpenPosition.symbol}). Bỏ qua việc mở lệnh mới cho ${symbol}.`);
        if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
        return;
    }

    addLog(`>>> Đang mở lệnh SHORT ${symbol} với Funding Rate: ${fundingRate}`, true);
    try {
        // 1. Lấy thông tin symbol (đòn bẩy đã được cài đặt trước đó)
        const symbolInfo = await getExchangeInfo(); // Chỉ cần exchangeInfo vì maxLeverage đã có
        if (!symbolInfo || !symbolInfo[symbol]) {
            addLog(`❌ Không thể lấy thông tin symbol ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
            return;
        }
        
        // --- THAY ĐỔI: Chuyển logic đặt đòn bẩy vào đây, ngay trước khi mở lệnh ---
        addLog(`[DEBUG] Đang thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`❌ Không thể cài đặt đòn bẩy cho ${symbol}. Hủy mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        // ----------------------------------------------------------------------

        const pricePrecision = symbolInfo[symbol].pricePrecision;
        const quantityPrecision = symbolInfo[symbol].quantityPrecision;
        const minNotional = symbolInfo[symbol].minNotional;
        const minQty = symbolInfo[symbol].minQty;
        const stepSize = symbolInfo[symbol].stepSize;
        const tickSize = symbolInfo[symbol].tickSize;

        // 2. Lấy giá hiện tại
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
            return;
        }
        addLog(`[DEBUG] Giá hiện tại của ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // 3. Tính toán khối lượng lệnh
        const capitalToUse = usdtBalance * CAPITAL_PERCENTAGE_PER_TRADE; // Vốn USDT đầu tư
        let quantity = (capitalToUse * maxLeverage) / currentPrice; // Khối lượng theo giá trị đòn bẩy

        // Làm tròn quantity theo stepSize và quantityPrecision
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        // Đảm bảo quantity không nhỏ hơn minQty
        quantity = Math.max(minQty, quantity);

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Giá trị hợp đồng (${currentNotional.toFixed(pricePrecision)} USDT) quá nhỏ so với minNotional (${minNotional} USDT) cho ${symbol}. Không mở lệnh.`, true);
            addLog(`   Vốn USDT đầu tư: ${capitalToUse.toFixed(2)} USDT. Vị thế ước tính (đòn bẩy ${maxLeverage}x): ${currentNotional.toFixed(2)} USDT.`);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Khối lượng tính toán cho ${symbol} là ${quantity}. Quá nhỏ hoặc không hợp lệ. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
            return;
        }

        // 4. Thực hiện lệnh mở vị thế SHORT (SELL MARKET)
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' // Để nhận được thông tin chi tiết về lệnh đã khớp
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice); // Giá khớp lệnh trung bình hoặc giá hiện tại
        const openTime = new Date();
        const formattedOpenTime = `${openTime.toLocaleDateString('en-GB')} ${openTime.toLocaleTimeString('en-US', { hour12: false })}.${String(openTime.getMilliseconds()).padStart(3, '0')}`;

        addLog(`✅ Đã mở SHORT ${symbol} vào lúc ${formattedOpenTime}`, true);
        addLog(`  + Funding Rate: ${fundingRate}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Số tiền: ${capitalToUse.toFixed(2)} USDT`);
        addLog(`  + Khối lượng: ${quantity} ${symbol}`);
        addLog(`  + Giá vào lệnh: ${entryPrice.toFixed(pricePrecision)}`);

        // 5. Tính toán TP/SL theo yêu cầu mới (dựa trên vốn đầu tư ban đầu)
        const slAmountUSDT = capitalToUse * STOP_LOSS_PERCENTAGE; // Số tiền SL dựa trên vốn đầu tư
        const tpPercentage = TAKE_PROFIT_PERCENTAGES[maxLeverage]; // Lấy TP % theo maxLeverage
        const tpAmountUSDT = capitalToUse * tpPercentage; // Số tiền TP dựa trên vốn đầu tư

        // SL cho lệnh SHORT: giá tăng lên (giá hòa vốn + (số tiền SL / khối lượng))
        let slPrice = entryPrice + (slAmountUSDT / quantity);
        // TP cho lệnh SHORT: giá giảm xuống (giá hòa vốn - (số tiền TP / khối lượng))
        let tpPrice = entryPrice - (tpAmountUSDT / quantity);

        // Làm tròn TP/SL theo tickSize của sàn
        slPrice = Math.ceil(slPrice / tickSize) * tickSize; // SL luôn làm tròn lên để đảm bảo giá SL nằm trên giá vào lệnh
        tpPrice = Math.floor(tpPrice / tickSize) * tickSize; // TP luôn làm tròn xuống để đảm bảo giá TP nằm dưới giá vào lệnh

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`>>> Giá TP: ${tpPrice.toFixed(pricePrecision)}, Giá SL: ${slPrice.toFixed(pricePrecision)}`, true);
        addLog(`   (SL: ${STOP_LOSS_PERCENTAGE*100}% của ${capitalToUse.toFixed(2)} USDT = ${slAmountUSDT.toFixed(2)} USDT)`);
        addLog(`   (TP: ${tpPercentage*100}% của ${capitalToUse.toFixed(2)} USDT = ${tpAmountUSDT.toFixed(2)} USDT)`);


        // Lưu thông tin vị thế đang mở
        currentOpenPosition = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            tpPrice: tpPrice,
            slPrice: slPrice,
            openTime: openTime,
            pricePrecision: pricePrecision,
            tickSize: tickSize
        };

        // Bắt đầu interval kiểm tra vị thế và cập nhật đếm ngược frontend
        if(!positionCheckInterval) { // Chỉ tạo interval nếu chưa có
            positionCheckInterval = setInterval(async () => {
                // Chỉ chạy manageOpenPosition nếu botRunning là true
                if(botRunning) {
                    await manageOpenPosition();
                } else {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 1000); // Kiểm tra mỗi giây
        }
        startCountdownFrontend(); // Bắt đầu bộ đếm ngược cho frontend

    } catch (error) {
        addLog(`❌ Lỗi mở SHORT ${symbol}: ${error.msg || error.message}`, true);
        // Nếu có lỗi khi mở lệnh, đảm bảo bot có thể tìm kiếm cơ hội mới
        // bằng cách lên lịch lại.
        if(botRunning) scheduleNextMainCycle();
    }
}

// --- Hàm kiểm tra và quản lý vị thế đang mở ---
async function manageOpenPosition() {
    // Nếu không có vị thế hoặc đang trong quá trình đóng, thoát
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) { // Nếu không có vị thế nhưng interval vẫn chạy
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            stopCountdownFrontend(); // Dừng đếm ngược trên frontend
            if(botRunning) scheduleNextMainCycle(); // Lên lịch quét mới nếu không còn vị thế và bot đang chạy
        }
        return;
    }

    const { symbol, quantity, tpPrice, slPrice, openTime, pricePrecision } = currentOpenPosition;

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        // Nếu vượt quá thời gian tối đa, đóng lệnh ngay
        if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`⏱️ Vị thế ${symbol} vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`, true);
            await closeShortPosition(symbol, quantity, 'Hết thời gian');
            return; // Đã đóng, thoát khỏi hàm này
        }

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
            // Log lỗi giá, không dừng bot.
            addLog(`⚠️ Không thể lấy giá hiện tại cho ${symbol} khi quản lý vị thế. Đang thử lại...`);
            return;
        }

        let shouldClose = false;
        let closeReason = '';

        if (currentPrice <= tpPrice) {
            addLog(`✅ Vị thế ${symbol} đạt TP tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`, true);
            shouldClose = true;
            closeReason = 'TP';
        } else if (currentPrice >= slPrice) {
            addLog(`❌ Vị thế ${symbol} đạt SL tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`, true);
            shouldClose = true;
            closeReason = 'SL';
        }

        if (shouldClose) {
            await closeShortPosition(symbol, quantity, closeReason);
        }

    } catch (error) {
        addLog(`❌ Lỗi khi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        // Không xóa cờ isClosingPosition ở đây, nó sẽ được xử lý khi closeShortPosition hoàn tất
    }
}

// Hàm chạy logic tìm kiếm cơ hội
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot đã dừng', true);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bỏ qua quét mới.', true);
        scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
        return;
    }

    // --- THAY ĐỔI: Sửa thông báo quét để phản ánh việc quét vào phút :59 ---
    addLog('>>> Đang quét cơ hội mở lệnh (chỉ vào phút :59)...', true);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu (${MIN_USDT_BALANCE_TO_OPEN}). Tắt điện thoại đi uống bia đê`, true);
            scheduleNextMainCycle();
            return;
        }

        const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
        const now = Date.now();

        let eligibleCandidates = []; // Danh sách các đồng coin thỏa mãn điều kiện cơ bản

        for (const item of allFundingData) {
            const fundingRate = parseFloat(item.lastFundingRate);
            const nextFundingTimeMs = item.nextFundingTime; 
            
            // Điều kiện 1: Funding rate đủ âm và là cặp USDT
            if (fundingRate < MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                // Điều kiện 2: nextFundingTime của đồng coin này phải còn trong cửa sổ xem xét
                const timeToFundingMs = nextFundingTimeMs - now;
                const timeToFundingMinutes = timeToFundingMs / (1000 * 60);

                // Lọc sơ bộ để chỉ xem xét các coin sắp đến giờ funding
                // Kiểm tra nếu thời gian còn lại đến funding lớn hơn 0 (chưa qua)
                // VÀ nhỏ hơn hoặc bằng FUNDING_WINDOW_MINUTES (ví dụ: 1 phút)
                if (timeToFundingMinutes > 0 && timeToFundingMinutes <= FUNDING_WINDOW_MINUTES) {
                    const symbolInfo = await getSymbolFiltersAndMaxLeverage(item.symbol);
                    if (symbolInfo && typeof symbolInfo.maxLeverage === 'number' && symbolInfo.maxLeverage > 1) {
                        const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
                        const currentPrice = await getCurrentPrice(item.symbol);
                        if (currentPrice === null) {
                            addLog(`[DEBUG] Không thể lấy giá hiện tại ${item.symbol}. Bỏ qua.`);
                            continue;
                        }
                        let estimatedQuantity = (capitalToUse * symbolInfo.maxLeverage) / currentPrice;
                        estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                        estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));

                        const currentNotional = estimatedQuantity * currentPrice;

                        if (currentNotional >= symbolInfo.minNotional && estimatedQuantity > 0 && TAKE_PROFIT_PERCENTAGES[symbolInfo.maxLeverage] !== undefined) {
                            eligibleCandidates.push({
                                symbol: item.symbol,
                                fundingRate: fundingRate,
                                nextFundingTime: nextFundingTimeMs,
                                maxLeverage: symbolInfo.maxLeverage
                            });
                        } else {
                            let reason = 'Không rõ';
                            if (currentNotional < symbolInfo.minNotional) reason = `Không đủ minNotional (${symbolInfo.minNotional.toFixed(2)})`;
                            else if (estimatedQuantity <= 0) reason = `Khối lượng quá nhỏ (${estimatedQuantity})`;
                            else if (TAKE_PROFIT_PERCENTAGES[symbolInfo.maxLeverage] === undefined) reason = `Đòn bẩy ${symbolInfo.maxLeverage}x không có cấu hình TP`;
                            addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), gần giờ funding, nhưng KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh. Lý do: ${reason}.`);
                        }
                    } else {
                        addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), gần giờ funding, nhưng không tìm thấy thông tin đòn bẩy hoặc đòn bẩy <= 1. Bỏ qua.`);
                    }
                } else {
                    addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), nhưng KHÔNG GẦN giờ funding (còn ${timeToFundingMinutes.toFixed(1)} phút hoặc đã qua). Bỏ qua.`);
                }
            }
        }

        if (eligibleCandidates.length > 0) {
            // Sắp xếp ưu tiên: Funding rate âm nhất
            eligibleCandidates.sort((a, b) => a.fundingRate - b.fundingRate);

            let selectedCandidateToOpen = null; // Biến để lưu trữ đồng coin cuối cùng được chọn để mở lệnh

            // Duyệt qua các ứng viên đã sắp xếp (từ âm nhất)
            for (const candidate of eligibleCandidates) {
                const nowRefreshed = Date.now();
                
                // Tính toán thời điểm target để mở lệnh (1 giây trước giờ funding + offset)
                const targetOpenTimeMs = candidate.nextFundingTime - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
                const delayForExactOpenMs = targetOpenTimeMs - nowRefreshed;

                // Kiểm tra điều kiện "sắp trả funding" hợp lệ cho CHÍNH ĐỒNG COIN ĐÓ:
                // 1. delayForExactOpenMs phải dương (thời điểm mở lệnh còn ở tương lai).
                // 2. delayForExactOpenMs phải nằm trong cửa sổ cho phép mở lệnh (ví dụ: trong vòng ONLY_OPEN_IF_FUNDING_IN_SECONDS)
                // Điều này có nghĩa là chúng ta chọn một đồng coin mà thời gian mở lệnh của nó
                // NẰM TRONG KHOẢNG thời gian cho phép CHỜ ĐỂ MỞ LỆNH.
                if (delayForExactOpenMs > 0 && delayForExactOpenMs <= (ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000)) {
                    selectedCandidateToOpen = candidate; // Tìm thấy ứng viên phù hợp
                    break; // Thoát vòng lặp vì đã tìm được đồng coin âm nhất và sắp trả funding
                } else {
                    addLog(`[DEBUG] Bỏ qua ${candidate.symbol} (Funding: ${candidate.fundingRate}, Giờ Funding: ${formatTimeUTC7(new Date(candidate.nextFundingTime))}). Thời điểm mở lệnh mong muốn (${formatTimeUTC7(new Date(targetOpenTimeMs))}) không nằm trong cửa sổ chờ hợp lệ (còn ${Math.ceil(delayForExactOpenMs / 1000)}s, max ${ONLY_OPEN_IF_FUNDING_IN_SECONDS}s). Tiếp tục xét đồng khác.`, false);
                }
            }

            if (selectedCandidateToOpen) { // Nếu tìm được một ứng viên thực sự phù hợp để mở lệnh
                const nowFinal = Date.now(); // Lấy lại thời gian cuối cùng trước khi tính toán
                // Tính toán lại độ trễ cuối cùng trước khi đặt setTimeout
                const targetOpenTimeMs = selectedCandidateToOpen.nextFundingTime - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
                const delayForExactOpenMs = targetOpenTimeMs - nowFinal;

                // Cần đảm bảo delayForExactOpenMs vẫn còn dương sau khi tìm thấy
                if (delayForExactOpenMs <= 0) {
                    addLog(`⚠️ Đã quá thời điểm mở lệnh cho ${selectedCandidateToOpen.symbol}. Bỏ qua.`, true);
                    scheduleNextMainCycle();
                    return;
                }

                const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
                const currentPrice = await getCurrentPrice(selectedCandidateToOpen.symbol);
                let estimatedQuantity = 0;
                if (currentPrice !== null) {
                    const symbolInfo = exchangeInfoCache[selectedCandidateToOpen.symbol];
                    if (symbolInfo) {
                        estimatedQuantity = (capitalToUse * selectedCandidateToOpen.maxLeverage) / currentPrice;
                        estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                        estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
                    }
                }

                addLog(`\n✅ Đã chọn đồng coin: **${selectedCandidateToOpen.symbol}**`, true);
                addLog(`  + Funding Rate: **${selectedCandidateToOpen.fundingRate}**`);
                addLog(`  + Giờ trả Funding tiếp theo (tính toán): **${formatTimeUTC7(new Date(selectedCandidateToOpen.nextFundingTime))}**`);
                addLog(`  + Đòn bẩy tối đa: **${selectedCandidateToOpen.maxLeverage}x**`);
                addLog(`  + Số tiền dự kiến mở lệnh: **${capitalToUse.toFixed(2)} USDT** (Khối lượng ước tính: **${estimatedQuantity} ${selectedCandidateToOpen.symbol}**)`);
                addLog(`  + Lệnh sẽ được mở sau khoảng **${Math.ceil(delayForExactOpenMs / 1000)} giây** (vào lúc **${formatTimeUTC7(new Date(targetOpenTimeMs))}**).`, true);
                addLog(`>>> Đang chờ đến thời điểm mở lệnh chính xác...`, true);
                clearTimeout(nextScheduledTimeout); // Hủy lịch trình quét cũ
                nextScheduledTimeout = setTimeout(async () => {
                    if (!currentOpenPosition && botRunning) {
                        // --- THAY ĐỔI: Gọi openShortPosition (đã bao gồm cài đòn bẩy) ---
                        addLog(`>>> Đã đến giờ mở lệnh cho ${selectedCandidateToOpen.symbol} (phút :59). Đang thực hiện mở lệnh.`, true);
                        await openShortPosition(selectedCandidateToOpen.symbol, selectedCandidateToOpen.fundingRate, availableBalance, selectedCandidateToOpen.maxLeverage);
                    } else if (!botRunning) {
                        addLog('Bot đã bị dừng trong khi chờ. Hủy bỏ việc mở lệnh.', true);
                    } else {
                        addLog(`⚠️ Đã có vị thế được mở trong khi chờ (bởi luồng khác). Bỏ qua việc mở lệnh mới.`, true);
                    }
                }, delayForExactOpenMs);
            } else { // Không tìm thấy đồng coin nào phù hợp sau khi duyệt qua tất cả
                // --- THAY ĐỔI: Quay lại logic chờ đến phút :59 tiếp theo ---
                addLog('>>> Không tìm thấy đồng coin nào thỏa mãn điều kiện trong chu kỳ này. Đang chờ chu kỳ quét tiếp theo (vào phút :59).', true);
                scheduleNextMainCycle();
            }

        } else { // Không có đồng coin nào đạt điều kiện sơ bộ
            // --- THAY ĐỔI: Quay lại logic chờ đến phút :59 tiếp theo ---
            addLog('>>> Không tìm thấy cơ hội mở lệnh đủ điều kiện tại thời điểm này. Đang chờ chu kỳ quét tiếp theo (vào phút :59).', true);
            scheduleNextMainCycle();
        }
    } catch (error) {
        addLog('❌ Lỗi tìm kiếm: ' + (error.msg || error.message), true);
        // --- THAY ĐỔI: Quay lại logic chờ đến phút :59 tiếp theo nếu có lỗi ---
        scheduleNextMainCycle(); 
    }
}

// Hàm lên lịch chu kỳ chính của bot (quét hoặc chờ)
// --- THAY ĐỔI: Trả lại logic chờ đến phút :59 ---
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot đã dừng.', true);
        clearTimeout(nextScheduledTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bot sẽ không lên lịch quét mới mà chờ đóng vị thế hiện tại.', true);
        return; // manageOpenPosition sẽ tự động gọi scheduleNextMainCycle sau khi đóng
    }

    clearTimeout(nextScheduledTimeout); // Xóa bất kỳ lịch trình cũ nào

    const now = Date.now();
    const currentMinute = new Date(now).getUTCMinutes(); // Lấy phút hiện tại theo UTC
    let delayUntilNext59Minute;

    if (currentMinute < 59) {
        // Nếu đang ở phút < 59, chờ đến phút 59 của giờ hiện tại
        delayUntilNext59Minute = (59 - currentMinute) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    } else {
        // Nếu đang ở phút 59 hoặc sau 59, chờ đến phút 59 của giờ tiếp theo
        delayUntilNext59Minute = (60 - currentMinute + 59) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    }

    // Đảm bảo delay không âm (ví dụ: nếu chạy lúc 59:00:00, delay phải rất nhỏ)
    if (delayUntilNext59Minute <= 0) {
        delayUntilNext59Minute = 1000; // Chờ ít nhất 1 giây để tránh lỗi setTimeout với giá trị 0
    }

    const nextScanMoment = new Date(now + delayUntilNext59Minute);

    addLog(`>>> Bot đang đi uống bia sẽ trở lại lúc **${formatTimeUTC7(nextScanMoment)}**).`, true);

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) {
            await runTradingLogic();
        } else {
            addLog('Bot đã bị dừng.', true);
        }
    }, delayUntilNext59Minute);
}

// --- Hàm khởi động bot logic chính (nội bộ, không phải PM2 start) ---
async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot logic hiện đang chạy. Không cần khởi động lại.', true);
        return 'Bot logic hiện đang chạy.';
    }

    addLog('--- Khởi động Bot ---', true);
    addLog('>>> Đang kiểm tra kết nối API Key với Binance Futures...', true);

    try {
        await syncServerTime(); // Đồng bộ thời gian trước

        // Kiểm tra API Key bằng cách lấy thông tin tài khoản
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key hoạt động bình thường! Số dư USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`, true);

        // Load exchange info một lần khi khởi động
        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Lỗi load sàn (exchangeInfo). Bot sẽ dừng.', true);
            return 'Không thể load sàn (exchangeInfo).';
        }

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`, true);

        // Bắt đầu chu kỳ chính của bot (quét hoặc chờ)
        scheduleNextMainCycle();

        // Thiết lập kiểm tra vị thế định kỳ (dù không có lệnh vẫn chạy để đảm bảo
        // nếu có lệnh mở từ đâu đó thì cũng được quản lý)
        // Interval này sẽ chỉ thực sự xử lý nếu currentOpenPosition không null
        if (!positionCheckInterval) { // Tránh tạo trùng lặp
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    await manageOpenPosition();
                } else if (!botRunning && positionCheckInterval) {
                    // Nếu bot dừng, clear interval này
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 1000); // Kiểm tra mỗi giây nếu có vị thế đang mở
        }
        startCountdownFrontend(); // Khởi động bộ đếm ngược frontend ngay khi bot bắt đầu

        return 'Bot đã khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('❌ [Lỗi nghiêm trọng khi khởi động bot] ' + errorMsg, true);
        addLog('   -> Bot sẽ dừng hoạt động. Vui lòng kiểm tra và khởi động lại.', true);
       
        botRunning = false; // Đảm bảo cờ botRunning được đặt lại false nếu khởi động thất bại
        return `Lỗi khi khởi động bot: ${errorMsg}`;
    }
}

// --- Hàm dừng bot logic chính (nội bộ, không phải PM2 stop) ---
function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot logic hiện không chạy. Không cần dừng.', true);
        return 'Bot logic hiện không chạy.';
    }
    botRunning = false;
    clearTimeout(nextScheduledTimeout); // Hủy lịch trình tiếp theo
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval); // Dừng kiểm tra vị thế
        positionCheckInterval = null;
    }
    stopCountdownFrontend(); // Dừng bộ đếm ngược trên frontend
    addLog('--- Bot đã được dừng ---', true);
    botStartTime = null;
    return 'Bot đã dừng.';
}

// === KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ===
const app = express();

// Phục vụ file index.html từ thư mục hiện tại (sau khi đã đổi tên)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint để lấy log từ file
app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading log file:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Log file not found: ${BOT_LOG_FILE}. Please ensure the path is correct and PM2 is running this bot with correct log output.`);
            }
            return res.status(500).send('Error reading log file');
        }
        // Xóa các ký tự màu sắc ANSI để hiển thị sạch hơn trên trình duyệt
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        res.send(cleanData);
    });
});

// API endpoint để lấy trạng thái bot từ PM2
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
            statusMessage = `MAY CHU: ${botProcess.pm2_env.status.toUpperCase()} (  Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRANG THAI: ${botRunning ? 'DANG CHAY' : 'DA DUNG'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | DA CHAY: ${uptimeMinutes} phút`;
                }
            }
        } else {
            statusMessage = `Bot Status: Not found in PM2 (Name: ${THIS_BOT_PM2_NAME})`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Error fetching PM2 status:', error);
        res.status(500).send(`Bot Status: Error fetching status. (${error})`);
    }
});

// NEW: API endpoint để lấy thông báo đếm ngược
app.get('/api/countdown', (req, res) => {
    res.send(currentCountdownMessage);
});

// API endpoint để khởi động bot logic chính (nội bộ)
app.get('/start_bot_logic', async (req, res) => {
    const message = await startBotLogicInternal();
    res.send(message);
});

// API endpoint để dừng bot logic chính (nội bộ)
app.get('/stop_bot_logic', (req, res) => {
    const message = stopBotLogicInternal();
    res.send(message);
});

// === DÒNG QUAN TRỌNG ĐỂ LẮNG NGHE CỔNG ===
app.listen(WEB_SERVER_PORT, () => {
    console.log(`Bot chờ khởi chạy:${WEB_SERVER_PORT}`);
    console.log(`Truy cập:${WEB_SERVER_PORT}`);
});
