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
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); // Thay thế bằng API Key của bạn
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // Thay thế bằng Secret Key của bạn

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0;

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

// === Cấu hình Bot ===
const MIN_USDT_BALANCE_TO_OPEN = 0.1; // Số dư USDT tối thiểu để mở lệnh (đã điều chỉnh)
const CAPITAL_PERCENTAGE_PER_TRADE = 0.5; // Phần trăm vốn sử dụng cho mỗi lệnh (50% tài khoản)

// Cấu hình TP/SL theo yêu cầu mới
const STOP_LOSS_PERCENTAGE = 0.70; // SL cố định 70% của vốn đầu tư ban đầu

// Bảng ánh xạ maxLeverage với Take Profit percentage
// Đảm bảo các giá trị đòn bẩy được định nghĩa ở đây.
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.20,
    25: 0.25,
    50: 0.50,
    75: 0.75,
    100: 1.00,
    125: 1.25,
};

const MIN_FUNDING_RATE_THRESHOLD = -0.0004; // Ngưỡng funding rate âm tối thiểu để xem xét (đã điều chỉnh: -0.04%)
const MAX_POSITION_LIFETIME_SECONDS = 180; // Thời gian tối đa giữ một vị thế (180 giây = 3 phút)

// Cấu hình thời gian chạy bot theo giờ UTC
const SCAN_MINUTE_UTC = 58; // Bot sẽ quét vào phút :58
const OPEN_ORDER_MILLISECOND_OFFSET = 100; // Mở lệnh vào giây :00 mili giây :100 của giờ tiếp theo

// Các giờ funding chính trong ngày (UTC) - bot sẽ ưu tiên quét vào các giờ này
const FUNDING_HOURS_UTC = [0, 8, 16]; // Ví dụ: 00:00, 08:00, 16:00 UTC

// === Cấu hình Server Web ===
const WEB_SERVER_PORT = 3000; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc)
// !!! QUAN TRỌNG: ĐÃ SỬA ĐƯỜNG DẪN NÀY ĐỂ TRỎ ĐÚNG VÀO FILE LOG CỦA BẠN !!!
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-binance-out.log'; // Đã sửa
const THIS_BOT_PM2_NAME = 'bot_bina'; // Đã sửa để khớp với tên bạn đang dùng

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
        addLog(`❌ Lỗi khi lấy getLeverageBracketForSymbol cho ${symbol}: ${error.msg || error.message}`);
        return null;
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
    addLog('>>> Đã tải thông tin sàn và cache thành công.', true);
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
    addLog(`❌ Lỗi khi lấy giá cho ${symbol}: ` + (error.msg || error.message));
    return null;
}
}

// --- Hàm chính để đóng lệnh Short ---
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) return; // Đang đóng lệnh, không làm gì thêm
    isClosingPosition = true; // Đặt cờ

    addLog(`>>> Đang cố gắng đóng lệnh SHORT cho ${symbol} với khối lượng ${quantityToClose}. Lý do: ${reason}.`);
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

        addLog(`✅ Đã đóng vị thế SHORT thành công cho ${symbol}.`, true);
        currentOpenPosition = null;
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
            positionCheckInterval = null;
        }
        isClosingPosition = false;
        if(botRunning) scheduleNextMainCycle(); // Lên lịch cho lần quét tiếp theo nếu bot đang chạy

    } catch (error) {
        addLog(`❌ Lỗi khi đóng lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false; // Xóa cờ ngay cả khi có lỗi để thử lại
    }
}

// --- Hàm chính để mở lệnh Short ---
async function openShortPosition(symbol, fundingRate, usdtBalance) {
    if (currentOpenPosition) {
        addLog(`⚠️ Đã có vị thế đang mở (${currentOpenPosition.symbol}). Bỏ qua việc mở lệnh mới cho ${symbol}.`);
        if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
        return;
    }

    addLog(`>>> Đang cố gắng mở lệnh SHORT cho ${symbol} với Funding Rate: ${fundingRate}`, true);
    try {
        // 1. Lấy thông tin symbol và đòn bẩy
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo || typeof symbolInfo.maxLeverage !== 'number' || symbolInfo.maxLeverage <= 1) {
            addLog(`❌ Không thể lấy thông tin đòn bẩy hợp lệ cho ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
            return;
        }
        const maxLeverage = symbolInfo.maxLeverage;
        const pricePrecision = symbolInfo.pricePrecision;
        const quantityPrecision = symbolInfo.quantityPrecision;
        const minNotional = symbolInfo.minNotional;
        const minQty = symbolInfo.minQty;
        const stepSize = symbolInfo.stepSize;
        const tickSize = symbolInfo.tickSize;

        // 2. Đặt đòn bẩy cho cặp giao dịch
        addLog(`[DEBUG] Đang thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: maxLeverage
        });
        addLog(`✅ Đã thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);

        // 3. Lấy giá hiện tại
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
            return;
        }
        addLog(`[DEBUG] Giá hiện tại của ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // 4. Tính toán khối lượng lệnh
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

        // 5. Thực hiện lệnh mở vị thế SHORT (SELL MARKET)
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

        addLog(`✅ Đã mở lệnh SHORT thành công cho ${symbol} vào lúc ${formattedOpenTime}`, true);
        addLog(`  + Funding Rate: ${fundingRate}`);
        addLog(`  + Đòn bẩy sử dụng: ${maxLeverage}x`);
        addLog(`  + Vốn USDT vào lệnh: ${capitalToUse.toFixed(2)} USDT`);
        addLog(`  + Khối lượng: ${quantity} ${symbol}`);
        addLog(`  + Giá vào lệnh: ${entryPrice.toFixed(pricePrecision)}`);

        // 6. Tính toán TP/SL theo yêu cầu mới (dựa trên vốn đầu tư ban đầu)
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

        // Bắt đầu interval kiểm tra vị thế
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

    } catch (error) {
        addLog(`❌ Lỗi khi mở lệnh SHORT cho ${symbol}: ${error.msg || error.message}`, true);
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
            if(botRunning) scheduleNextMainCycle(); // Lên lịch quét mới nếu không còn vị thế và bot đang chạy
        }
        return;
    }

    const { symbol, quantity, tpPrice, slPrice, openTime, pricePrecision } = currentOpenPosition;

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
            // Hiển thị trạng thái chờ giá trên cùng một dòng
            process.stdout.write(`\r>>> Đang kiểm tra vị thế ${symbol} (${quantity}). Đã mở ${elapsedTimeSeconds.toFixed(0)}/${MAX_POSITION_LIFETIME_SECONDS} giây. (Đang lấy giá...)            `);
            return;
        }

        // Log đếm ngược thời gian còn lại trên cùng một dòng
        const timeLeft = MAX_POSITION_LIFETIME_SECONDS - Math.floor(elapsedTimeSeconds);
        process.stdout.write(`\r>>> Vị thế ${symbol}: Đang mở, còn lại ${timeLeft} giây. Giá hiện tại: ${currentPrice.toFixed(pricePrecision)} | TP: ${tpPrice.toFixed(pricePrecision)} | SL: ${slPrice.toFixed(pricePrecision)}                                 `);

        let shouldClose = false;
        let closeReason = '';

        if (currentPrice <= tpPrice) {
            addLog(`\n✅ Vị thế ${symbol} đạt TP tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`, true);
            shouldClose = true;
            closeReason = 'TP';
        } else if (currentPrice >= slPrice) {
            addLog(`\n❌ Vị thế ${symbol} đạt SL tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`, true);
            shouldClose = true;
            closeReason = 'SL';
        } else if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`\n⏱️ Vị thế ${symbol} vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`, true);
            shouldClose = true;
            closeReason = 'Hết thời gian';
        }

        if (shouldClose) {
            // Xóa dòng đếm ngược khi chuẩn bị đóng lệnh
            process.stdout.write('\r' + ' '.repeat(process.stdout.columns || 80) + '\r');
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
        addLog('Bot đã dừng. Không chạy logic tìm kiếm cơ hội.', true);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bỏ qua tìm kiếm cơ hội mới.', true);
        scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
        return;
    }

    addLog('>>> Đang quét tìm symbol có funding rate âm và đủ điều kiện...', true);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset); // Đảm bảo là số

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu (${MIN_USDT_BALANCE_TO_OPEN}). Không tìm kiếm cơ hội.`, true);
            scheduleNextMainCycle(); // Lên lịch quét lại nếu bot đang chạy
            return;
        }

        const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');

        const candidatesForOpening = []; // Các ứng viên đủ điều kiện để mở lệnh
        const otherNegativeFundingSymbols = []; // Các symbol có funding âm nhưng không đủ điều kiện mở

        for (const item of allFundingData) {
            const fundingRate = parseFloat(item.lastFundingRate);
            if (fundingRate < MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                const symbolInfo = await getSymbolFiltersAndMaxLeverage(item.symbol);
                if (symbolInfo && typeof symbolInfo.maxLeverage === 'number' && symbolInfo.maxLeverage > 1) {
                    const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
                    const currentPrice = await getCurrentPrice(item.symbol);
                    if (currentPrice === null) {
                        addLog(`[DEBUG] Không thể lấy giá hiện tại cho ${item.symbol}. Bỏ qua.`);
                        otherNegativeFundingSymbols.push({ symbol: item.symbol, fundingRate: fundingRate, reason: 'Giá không lấy được' });
                        continue;
                    }
                    let estimatedQuantity = (capitalToUse * symbolInfo.maxLeverage) / currentPrice;
                    estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                    estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));

                    const currentNotional = estimatedQuantity * currentPrice;

                    if (currentNotional >= symbolInfo.minNotional && estimatedQuantity > 0 && TAKE_PROFIT_PERCENTAGES[symbolInfo.maxLeverage] !== undefined) {
                        candidatesForOpening.push({
                            symbol: item.symbol,
                            fundingRate: fundingRate,
                            nextFundingTime: item.nextFundingTime,
                            maxLeverage: symbolInfo.maxLeverage
                        });
                    } else {
                        let reason = 'Không rõ';
                        if (currentNotional < symbolInfo.minNotional) reason = `Không đủ minNotional (${symbolInfo.minNotional})`;
                        else if (estimatedQuantity <= 0) reason = `Khối lượng quá nhỏ (${estimatedQuantity})`;
                        else if (TAKE_PROFIT_PERCENTAGES[symbolInfo.maxLeverage] === undefined) reason = `Đòn bẩy ${symbolInfo.maxLeverage}x không có cấu hình TP`;
                        addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), nhưng KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh. Lý do: ${reason}.`);
                        otherNegativeFundingSymbols.push({ symbol: item.symbol, fundingRate: fundingRate, reason: reason });
                    }
                } else {
                    addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), nhưng không tìm thấy thông tin đòn bẩy hoặc đòn bẩy <= 1. Bỏ qua.`);
                    otherNegativeFundingSymbols.push({ symbol: item.symbol, fundingRate: fundingRate, reason: 'Không có thông tin đòn bẩy hoặc đòn bẩy <= 1' });
                }
            }
        }

        // Log các đồng có funding âm nhưng không đủ điều kiện
        if (otherNegativeFundingSymbols.length > 0) {
            addLog(`⚠️ Các đồng coin có funding âm nhưng không đủ điều kiện mở lệnh:`);
            otherNegativeFundingSymbols.forEach(c => {
                addLog(`  - ${c.symbol} (Funding: ${c.fundingRate}, Lý do: ${c.reason})`);
            });
        }

        if (candidatesForOpening.length > 0) {
            candidatesForOpening.sort((a, b) => a.fundingRate - b.fundingRate);
            const selectedCandidate = candidatesForOpening[0]; // Lấy ứng viên tốt nhất (funding rate âm nhất)

            const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
            const currentPrice = await getCurrentPrice(selectedCandidate.symbol); // Lấy lại giá ngay trước khi in log

            let estimatedQuantity = (capitalToUse * selectedCandidate.maxLeverage) / currentPrice;
            const symbolInfo = exchangeInfoCache[selectedCandidate.symbol]; // Lấy từ cache
            if (symbolInfo) {
                estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
            }

            // Tính toán thời điểm mở lệnh: 00 giây 100ms của giờ tiếp theo
            const now = new Date();
            let targetOpenTime = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, OPEN_ORDER_MILLISECOND_OFFSET);

            // Nếu thời điểm hiện tại đã qua giờ funding chính (ví dụ 00:00:00.100),
            // thì mục tiêu sẽ là giờ funding tiếp theo.
            // Logic này đã được xử lý trong scheduleNextMainCycle để chọn đúng thời điểm quét (phút 58).
            // Do đó, khi đến được đây (runTradingLogic), targetOpenTime luôn là giờ tiếp theo.

            const timeLeftMs = targetOpenTime.getTime() - now.getTime();
            const timeLeftSeconds = Math.max(0, Math.ceil(timeLeftMs / 1000));

            addLog(`\n✅ Đã chọn đồng coin: **${selectedCandidate.symbol}**`, true);
            addLog(`  + Funding Rate: **${selectedCandidate.fundingRate}**`);
            addLog(`  + Đòn bẩy tối đa: **${selectedCandidate.maxLeverage}x**`);
            addLog(`  + Số tiền dự kiến mở lệnh: **${capitalToUse.toFixed(2)} USDT** (Khối lượng ước tính: **${estimatedQuantity} ${selectedCandidate.symbol}**)`);
            addLog(`  + Lệnh sẽ được mở vào lúc **${formatTimeUTC7(targetOpenTime)}** (còn khoảng **${timeLeftSeconds} giây** đếm ngược).`);

            addLog(`>>> Đang chờ đến thời điểm mở lệnh...`, true);
            await delay(timeLeftMs);

            // Sau khi chờ, kiểm tra lại xem có vị thế nào được mở trong khi chờ không
            if (!currentOpenPosition && botRunning) { // Chỉ mở nếu bot đang chạy và chưa có vị thế
                await openShortPosition(selectedCandidate.symbol, selectedCandidate.fundingRate, availableBalance);
            } else if (!botRunning) {
                addLog('Bot đã bị dừng trong khi chờ. Hủy bỏ việc mở lệnh.', true);
                scheduleNextMainCycle(); // Cố gắng lên lịch lại nếu bot đã dừng
            } else {
                addLog(`⚠️ Đã có vị thế được mở trong khi chờ (bởi luồng khác). Bỏ qua việc mở lệnh mới.`, true);
                // Vì đã có lệnh khác mở, không cần lên lịch quét lại ngay,
                // manageOpenPosition sẽ lo việc đóng lệnh và sau đó gọi scheduleNextMainCycle.
            }

        } else {
            addLog('>>> Không tìm thấy cơ hội Shorting với funding rate đủ tốt và đủ điều kiện. Bot sẽ ngủ cho đến phiên quét tiếp theo.', true);
            scheduleNextMainCycle(); // Lên lịch quét lại nếu không tìm thấy cơ hội
        }
    } catch (error) {
        addLog('❌ Lỗi trong quá trình tìm kiếm cơ hội: ' + (error.msg || error.message), true);
        scheduleNextMainCycle(); // Lên lịch quét lại nếu có lỗi
    }
}

// Hàm lên lịch chu kỳ chính của bot (quét hoặc chờ)
async function scheduleNextMainCycle() {
    if (!botRunning) { // Nếu bot đã bị dừng, không lên lịch nữa
        addLog('Bot đã dừng. Không chạy logic giao dịch hoặc lên lịch tiếp theo.', true);
        clearTimeout(nextScheduledTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bot sẽ không lên lịch quét mới mà chờ đóng vị thế hiện tại.');
        // ManageOpenPosition sẽ tự động gọi scheduleNextMainCycle sau khi đóng.
        return; // Managed by manageOpenPosition
    }

    clearTimeout(nextScheduledTimeout); // Xóa bất kỳ lịch trình cũ nào

    const now = new Date();
    let nextScanMoment = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
                                now.getUTCHours(), SCAN_MINUTE_UTC, 0, 0); // Quét vào phút :58, giây 0, mili giây 0

    // Nếu thời gian quét đã qua trong giờ hiện tại, chuyển sang giờ tiếp theo
    if (nextScanMoment.getTime() <= now.getTime()) {
        nextScanMoment.setUTCHours(nextScanMoment.getUTCHours() + 1);
    }

    // Đảm bảo giây và mili giây được đặt lại cho thời điểm quét
    nextScanMoment.setUTCSeconds(0);
    nextScanMoment.setUTCMilliseconds(0); // Đặt về 0 để tính toán chính xác từ phút 58

    // Xác định xem phiên quét này có phải là phiên funding chính hay không
    let isFundingScan = FUNDING_HOURS_UTC.includes(nextScanMoment.getUTCHours());

    // In log tùy thuộc vào việc đây có phải là giờ funding hay không
    if (isFundingScan) {
        addLog(`>>> Lịch trình: Phiên quét sắp tới vào **${formatTimeUTC7(nextScanMoment)}** sẽ tập trung cho giờ Funding **${nextScanMoment.getUTCHours()}:00 UTC**.`, true);
    } else {
        addLog(`>>> Lịch trình: Bot sẽ quét vào **${formatTimeUTC7(nextScanMoment)}** (không phải giờ Funding chính, nhưng vẫn quét để tìm cơ hội).`, true);
    }

    const delayMs = nextScanMoment.getTime() - now.getTime();

    if (delayMs < 0) { // Trường hợp đặc biệt nếu tính toán bị âm (hiếm khi xảy ra với logic trên)
        addLog(`⚠️ [Lỗi Lịch trình] Thời gian chờ âm: ${delayMs} ms. Đang điều chỉnh lại.`);
        if(botRunning) scheduleNextMainCycle(); // Nếu thời gian đã qua, lên lịch lại ngay lập tức
        return;
    }

    addLog(`>>> Bot sẽ chạy logic quét vào lúc: ${formatTimeUTC7(nextScanMoment)}. Thời gian chờ: ${Math.round(delayMs / 1000)} giây.`, true);

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) { // Chỉ chạy nếu bot vẫn đang hoạt động
            await runTradingLogic(); // Chạy logic tìm kiếm cơ hội
        } else {
            addLog('Bot đã bị dừng. Hủy bỏ việc thực thi lịch trình.', true);
        }
    }, delayMs);
}

// --- Hàm khởi động bot logic chính (nội bộ, không phải PM2 start) ---
async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot logic hiện đang chạy. Không cần khởi động lại.', true);
        return 'Bot logic hiện đang chạy.';
    }

    addLog('--- Khởi động Bot Futures Funding Rate ---', true);
    addLog('>>> Đang kiểm tra kết nối API Key với Binance Futures...', true);

    // Kiểm tra API Key và Secret Key đã được thay thế chưa
    if (API_KEY === 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim() || SECRET_KEY === 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim()) {
        addLog('❌ LỖI CẤU HÌNH: Vui lòng thay thế API Key và Secret Key THẬT của bạn.', true);
        return 'LỖI CẤU HÌNH: Vui lòng thay thế API Key và Secret Key THẬT của bạn.';
    }

    try {
        await syncServerTime(); // Đồng bộ thời gian trước

        // Kiểm tra API Key bằng cách lấy thông tin tài khoản
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key hoạt động bình thường! Số dư USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`, true);

        // Load exchange info một lần khi khởi động
        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Không thể tải thông tin sàn (exchangeInfo). Bot sẽ dừng.', true);
            return 'Không thể tải thông tin sàn (exchangeInfo).';
        }

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã được KHỞI ĐỘNG thành công vào lúc ${formatTimeUTC7(botStartTime)} ---`, true);

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
        return 'Bot đã khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('❌ [Lỗi nghiêm trọng khi khởi động bot] ' + errorMsg, true);
        addLog('   -> Bot sẽ dừng hoạt động. Vui lòng kiểm tra và khởi động lại.', true);
        addLog('   -> Gợi ý: Nếu lỗi là "-1022 Signature for this request is not valid.", hãy kiểm tra lại API Key/Secret và đặc biệt là danh sách IP trắng trên Binance.', true);
        addLog('   -> Gợi ý: Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", hãy kiểm tra lại đồng bộ thời gian trên VPS (`sudo ntpdate pool.ntp.org` và `timedatectl status`).', true);
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

        let statusMessage = 'Bot Status: Offline (PM2)';
        if (botProcess) {
            statusMessage = `Bot Status: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | Internal Logic: ${botRunning ? 'RUNNING' : 'STOPPED'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | Internal Uptime: ${uptimeMinutes} phút`;
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
    console.log(`Web server cho Bot Futures Funding Rate đang lắng nghe tại http://localhost:${WEB_SERVER_PORT}`);
    console.log(`Truy cập giao diện web qua trình duyệt: http://YOUR_VPS_IP:${WEB_SERVER_PORT}`);
});
