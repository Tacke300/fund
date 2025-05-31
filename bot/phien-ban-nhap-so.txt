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
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // THAY THẾ BẰNG SECRET KEY THẬT CỦA BẠN

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
let nextScheduledTimeout = null; 

// Biến và interval cho việc hiển thị đếm ngược trên giao diện web
let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null; 

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
// Số dư USDT tối thiểu trong ví futures để bot được phép mở lệnh
const MIN_USDT_BALANCE_TO_OPEN = 0.1; 
// SỐ TIỀN USDT CỐ ĐỊNH SẼ DÙNG CHO MỖI LỆNH ĐẦU TƯ BAN ĐẦU.
// ĐẢM BẢO GIÁ TRỊ NÀY ĐỦ LỚN ĐỂ VƯỢT QUA minNotional CỦA SÀN.
// Ví dụ: 0.15 USDT có thể quá nhỏ cho nhiều cặp giao dịch trên Binance Futures.
// Hãy đặt nó lên 10, 20 hoặc 50 USDT để tránh lỗi 'minNotional'.
const FIXED_USDT_AMOUNT_PER_TRADE = 0.2; // Ví dụ: đặt 10 hoặc 20 cho minNotional.

// Cấu hình Stop Loss:
// SL cố định X% của vốn đầu tư ban đầu (FIXED_USDT_AMOUNT_PER_TRADE)
const STOP_LOSS_PERCENTAGE = 0.5; // 1 = 100% của FIXED_USDT_AMOUNT_PER_TRADE

// Bảng ánh xạ maxLeverage với Take Profit percentage.
// TP được tính dựa trên X% của vốn đầu tư ban đầu (FIXED_USDT_AMOUNT_PER_TRADE).
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.5,  // 50% TP nếu đòn bẩy 20x
    25: 0.5,  // 80% TP nếu đòn bẩy 25x
    50: 0.75,    // 100% TP nếu đòn bẩy 50x
    75: 1,    // 100% TP nếu đòn bẩy 75x
    100: 1.5, // 150% TP nếu đòn bẩy 100x
    125: 2,   // 200% TP nếu đòn bẩy 125x
};

// Ngưỡng funding rate âm tối thiểu để xem xét mở lệnh (ví dụ: -0.005 = -0.5%)
const MIN_FUNDING_RATE_THRESHOLD = -0.005; 
// Thời gian tối đa giữ một vị thế (ví dụ: 90 giây = 1 phút 30 giây)
const MAX_POSITION_LIFETIME_SECONDS = 90; 

// Cửa sổ thời gian (tính bằng phút) TRƯỚC giờ funding mà bot sẽ bắt đầu quét.
// Đặt là 1 phút để chỉ quét vào phút :59.
const FUNDING_WINDOW_MINUTES = 1; 

// Chỉ mở lệnh nếu thời gian còn lại đến funding <= X giây.
// Đặt là 60 để đảm bảo chỉ mở trong phút :59.
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 

// Thời gian (giây) TRƯỚC giờ funding chính xác mà bot sẽ cố gắng đặt lệnh.
// Đặt là 1 để cố gắng mở lệnh vào giây :59.
const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; 
// Thời gian (mili giây) LỆCH so với giây :59 để mở lệnh (để tránh quá tải).
// Đặt là 755ms để lệnh được gửi vào 59.755s.
const OPEN_TRADE_AFTER_SECOND_OFFSET_MS = 755; 

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 3000; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc).
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn.
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bina-out.log';
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'bot_bina';

// --- HÀM TIỆN ÍCH ---

// Ghi nhật ký vào console với timestamp và màu sắc
function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

    // Thêm màu sắc cho log trong console để dễ đọc
    if (message.startsWith('✅')) {
        logEntry = `\x1b[32m${logEntry}\x1b[0m`; // Xanh lá
    } else if (message.startsWith('❌')) {
        logEntry = `\x1b[31m${logEntry}\x1b[0m`; // Đỏ
    } else if (message.startsWith('⚠️')) {
        logEntry = `\x1b[33m${logEntry}\x1b[0m`; // Vàng
    } else if (isImportant) {
        logEntry = `\x1b[36m${logEntry}\x1b[0m`; // Xanh dương (Cyan) cho tin quan trọng
    }

    console.log(logEntry);
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

// Hàm delay bất đồng bộ
const delay = ms => new Promise(resolve => setTimeout(() => resolve(), ms));

// Tạo chữ ký HMAC SHA256 cho các yêu cầu API
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                        .update(queryString)
                        .digest('hex');
}

// Gửi HTTP request cơ bản
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

// Gọi API Binance có chữ ký (dùng cho các thao tác tài khoản, lệnh)
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const recvWindow = 5000; // Thời gian tối đa cho phép request hợp lệ
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
            addLog("  Gợi ý: Lỗi chữ ký không hợp lệ. Điều này có thể do API Key/Secret bị sai, hoặc có vấn đề trong cách bạn xây dựng chuỗi tham số để ký.");
        } else if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
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

// Đồng bộ thời gian với server Binance để tránh lỗi timestamp
async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
        addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms.`, true);
    } catch (error) {
        addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}.`, true);
        serverTimeOffset = 0; // Đặt về 0 nếu không đồng bộ được
    }
}

// Lấy thông tin đòn bẩy tối đa cho một symbol cụ thể
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });

        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);

            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                // Lấy bracket đầu tiên cho đòn bẩy tối đa (thường là cấp đầu tiên)
                const firstBracket = symbolData.brackets[0];
                if (firstBracket.maxInitialLeverage !== undefined) {
                    const maxLev = parseInt(firstBracket.maxInitialLeverage);
                    return maxLev;
                } else if (firstBracket.initialLeverage !== undefined) { 
                    const maxLev = parseInt(firstBracket.initialLeverage);
                    return maxLev;
                }
            }
        }
        addLog(`[DEBUG] Không tìm thấy thông tin đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`❌ Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Thiết lập đòn bẩy cho một symbol
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
        // Xử lý lỗi cụ thể nếu cần, ví dụ: đòn bẩy không hợp lệ
        return false;
    }
}

// Lấy thông tin sàn (exchangeInfo) và cache lại
async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    addLog('>>> Đang lấy exchangeInfo từ Binance Futures...', true);
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`, true);

        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            // Tìm các bộ lọc cần thiết từ API Binance
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE'); // Dự phòng
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                // minQty là khối lượng tối thiểu của lệnh
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                // stepSize là bước nhảy tối thiểu của khối lượng
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
                // minNotional là giá trị hợp đồng tối thiểu (khối lượng * giá)
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision, // Số chữ số thập phân cho giá
                quantityPrecision: s.quantityPrecision, // Số chữ số thập phân cho khối lượng
                // tickSize là bước nhảy tối thiểu của giá
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

// Hàm kết hợp để lấy tất cả filters và maxLeverage cho một symbol
async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();

    if (!filters || !filters[symbol]) {
        addLog(`[DEBUG] Không tìm thấy filters cho ${symbol}.`);
        return null;
    }

    const maxLeverage = await getLeverageBracketForSymbol(symbol);

    return {
        ...filters[symbol],
        maxLeverage: maxLeverage
    };
}

// Lấy giá hiện tại của một symbol
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

// --- HÀM QUẢN LÝ LỆNH ---

// Hàm đóng lệnh Short
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    if (isClosingPosition) {
        addLog(`⚠️ Đang trong quá trình đóng lệnh. Bỏ qua yêu cầu đóng lệnh mới cho ${symbol}.`);
        return; 
    }
    isClosingPosition = true; // Đặt cờ để ngăn các lệnh đóng trùng lặp

    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol} với khối lượng ${quantityToClose}. Lý do: ${reason}.`);
    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            addLog(`❌ Không thể lấy thông tin symbol cho ${symbol} để đóng lệnh.`);
            isClosingPosition = false;
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        const adjustedQuantity = parseFloat(quantityToClose.toFixed(quantityPrecision));

        // Kiểm tra vị thế thực tế trên Binance để đảm bảo có vị thế để đóng
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) < 0); // Tìm vị thế SHORT

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> Không có vị thế SHORT để đóng cho ${symbol} hoặc đã đóng trên sàn.`, true);
            currentOpenPosition = null;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval); 
                positionCheckInterval = null;
            }
            stopCountdownFrontend(); // Dừng đếm ngược trên frontend
            if(botRunning) scheduleNextMainCycle(); // Lên lịch cho lần quét tiếp theo nếu bot đang chạy
            isClosingPosition = false;
            return;
        }
        
        // Cập nhật khối lượng để đóng theo khối lượng thực tế trên sàn nếu có sự sai lệch nhỏ
        const actualQuantityToClose = Math.abs(parseFloat(currentPositionOnBinance.positionAmt));
        const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

        // Gửi lệnh đóng
        addLog(`[DEBUG] Gửi lệnh đóng SHORT: symbol=${symbol}, side=BUY, type=MARKET, quantity=${adjustedActualQuantity}, reduceOnly=true`);

        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY', // Để đóng lệnh SHORT, cần lệnh BUY
            type: 'MARKET',
            quantity: adjustedActualQuantity,
            reduceOnly: 'true' // Đảm bảo lệnh này chỉ để giảm vị thế
        });

        addLog(`✅ Đã đóng vị thế SHORT ${symbol}.`, true);
        currentOpenPosition = null; // Xóa vị thế đang mở
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
            positionCheckInterval = null;
        }
        stopCountdownFrontend(); // Dừng đếm ngược trên frontend
        if(botRunning) scheduleNextMainCycle(); // Lên lịch cho lần quét tiếp theo nếu bot đang chạy
        isClosingPosition = false; // Xóa cờ sau khi hoàn tất

    } catch (error) {
        addLog(`❌ Lỗi đóng lệnh SHORT ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false; // Xóa cờ ngay cả khi có lỗi để cho phép thử lại
    }
}

// Bắt đầu bộ đếm ngược cho frontend
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
            stopCountdownFrontend(); // Dừng nếu không có vị thế
        }
    }, 1000); // Cập nhật mỗi giây
}

// Dừng bộ đếm ngược cho frontend
function stopCountdownFrontend() {
    if (countdownIntervalFrontend) {
        clearInterval(countdownIntervalFrontend);
        countdownIntervalFrontend = null;
    }
    currentCountdownMessage = "Không có lệnh đang chờ đóng.";
}

// Hàm mở lệnh Short
async function openShortPosition(symbol, fundingRate, usdtBalance, maxLeverage) {
    if (currentOpenPosition) {
        addLog(`⚠️ Đã có vị thế đang mở (${currentOpenPosition.symbol}). Bỏ qua việc mở lệnh mới cho ${symbol}.`);
        if(botRunning) scheduleNextMainCycle(); 
        return;
    }

    addLog(`>>> Đang tiến hành mở lệnh SHORT ${symbol} với Funding Rate: ${fundingRate}`, true);
    try {
        // Lấy thông tin symbol và bộ lọc
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`❌ Không thể lấy thông tin chi tiết symbol ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        
        // Thiết lập đòn bẩy trước khi mở lệnh
        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            addLog(`❌ Không thể cài đặt đòn bẩy ${maxLeverage}x cho ${symbol}. Hủy mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        // Lấy giá hiện tại
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        addLog(`[DEBUG] Giá hiện tại của ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // Tính toán khối lượng lệnh dựa trên số tiền cố định (FIXED_USDT_AMOUNT_PER_TRADE)
        const capitalToUse = FIXED_USDT_AMOUNT_PER_TRADE; 

        if (usdtBalance < capitalToUse) {
            addLog(`⚠️ Số dư USDT khả dụng (${usdtBalance.toFixed(2)}) không đủ để mở lệnh với ${capitalToUse} USDT. Hủy mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }
        
        // Khối lượng tính toán (quantity)
        let quantity = (capitalToUse * maxLeverage) / currentPrice; 

        // Làm tròn quantity theo stepSize và quantityPrecision của sàn
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        // Đảm bảo quantity không nhỏ hơn minQty
        if (quantity < minQty) {
            addLog(`⚠️ Khối lượng tính toán (${quantity.toFixed(quantityPrecision)}) nhỏ hơn minQty (${minQty}) cho ${symbol}. Không thể mở lệnh.`, true);
            addLog(`   Vui lòng tăng FIXED_USDT_AMOUNT_PER_TRADE hoặc chọn cặp có minQty nhỏ hơn.`);
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        // Tính toán giá trị hợp đồng (notional) và đảm bảo nó lớn hơn minNotional
        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Giá trị hợp đồng (${currentNotional.toFixed(pricePrecision)} USDT) quá nhỏ so với minNotional (${minNotional} USDT) cho ${symbol}. Không thể mở lệnh.`, true);
            addLog(`   Vốn USDT đầu tư: ${capitalToUse.toFixed(2)} USDT. Vị thế ước tính (đòn bẩy ${maxLeverage}x): ${currentNotional.toFixed(2)} USDT.`);
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Khối lượng tính toán cho ${symbol} là ${quantity}. Không hợp lệ. Không mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        // Thực hiện lệnh mở vị thế SHORT (SELL MARKET)
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' 
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice); 
        const openTime = new Date();
        const formattedOpenTime = formatTimeUTC7(openTime);

        addLog(`✅ Đã mở SHORT ${symbol} vào lúc ${formattedOpenTime}`, true);
        addLog(`  + Funding Rate: ${fundingRate}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Số tiền đầu tư: ${capitalToUse.toFixed(2)} USDT`); 
        addLog(`  + Khối lượng: ${quantity} ${symbol}`);
        addLog(`  + Giá vào lệnh: ${entryPrice.toFixed(pricePrecision)}`);

        // Tính toán TP/SL dựa trên FIXED_USDT_AMOUNT_PER_TRADE
        const slAmountUSDT = capitalToUse * STOP_LOSS_PERCENTAGE; 
        const tpPercentage = TAKE_PROFIT_PERCENTAGES[maxLeverage]; 
        const tpAmountUSDT = capitalToUse * tpPercentage; 

        // Tính toán giá SL (giá tăng lên so với giá vào lệnh)
        let slPrice = entryPrice + (slAmountUSDT / quantity);
        // Tính toán giá TP (giá giảm xuống so với giá vào lệnh)
        let tpPrice = entryPrice - (tpAmountUSDT / quantity);

        // Làm tròn TP/SL theo tickSize của sàn
        slPrice = Math.ceil(slPrice / tickSize) * tickSize; // SL làm tròn lên để đảm bảo giá SL trên giá vào lệnh
        tpPrice = Math.floor(tpPrice / tickSize) * tickSize; // TP làm tròn xuống để đảm bảo giá TP dưới giá vào lệnh

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
            pricePrecision: pricePrecision
        };

        // Bắt đầu interval kiểm tra vị thế và cập nhật đếm ngược frontend
        if(!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                if(botRunning) { // Chỉ chạy nếu bot đang chạy
                    await manageOpenPosition();
                } else {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 1000); // Kiểm tra mỗi giây
        }
        startCountdownFrontend(); // Bắt đầu bộ đếm ngược trên frontend

    } catch (error) {
        addLog(`❌ Lỗi mở SHORT ${symbol}: ${error.msg || error.message}`, true);
        if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ để tìm cơ hội mới
    }
}

// Hàm kiểm tra và quản lý vị thế đang mở (SL/TP/Timeout)
async function manageOpenPosition() {
    // Nếu không có vị thế hoặc đang trong quá trình đóng, thoát
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) { 
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            stopCountdownFrontend(); 
            if(botRunning) scheduleNextMainCycle(); 
        }
        return;
    }

    const { symbol, quantity, tpPrice, slPrice, openTime, pricePrecision } = currentOpenPosition;

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        // Nếu vị thế vượt quá thời gian tối đa, đóng lệnh
        if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`⏱️ Vị thế ${symbol} vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`, true);
            await closeShortPosition(symbol, quantity, 'Hết thời gian');
            return; 
        }

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
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
    }
}

// Hàm chạy logic tìm kiếm cơ hội (chỉ chạy vào phút :59)
async function runTradingLogic() {
    if (!botRunning) {
        addLog('Bot đã dừng. Hủy bỏ chu kỳ quét.', true);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bỏ qua quét mới. Sẽ kiểm tra lại sau khi vị thế đóng.', true);
        // Không gọi scheduleNextMainCycle ở đây, manageOpenPosition sẽ gọi nó khi vị thế đóng
        return;
    }

    addLog('>>> Đang quét cơ hội mở lệnh (chỉ vào phút :59)...', true);
    try {
        // Lấy số dư USDT khả dụng
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        // Kiểm tra số dư tối thiểu để bot chạy
        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu để bot chạy (${MIN_USDT_BALANCE_TO_OPEN}). Tắt điện thoại đi uống bia đê`, true);
            scheduleNextMainCycle();
            return;
        }
        
        // Kiểm tra số dư đủ để vào lệnh với số tiền cố định
        if (availableBalance < FIXED_USDT_AMOUNT_PER_TRADE) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới số tiền cố định để vào lệnh (${FIXED_USDT_AMOUNT_PER_TRADE}). Không thể mở lệnh.`, true);
            scheduleNextMainCycle();
            return;
        }

        // Lấy tất cả premium index (bao gồm funding rate và nextFundingTime)
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

                // Lọc sơ bộ: chỉ xem xét các coin sắp đến giờ funding (trong FUNDING_WINDOW_MINUTES)
                if (timeToFundingMinutes > 0 && timeToFundingMinutes <= FUNDING_WINDOW_MINUTES) {
                    const symbolDetails = await getSymbolDetails(item.symbol);
                    // Đảm bảo có thông tin đòn bẩy và TP được cấu hình
                    if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1 && TAKE_PROFIT_PERCENTAGES[symbolDetails.maxLeverage] !== undefined) {
                        // ƯỚC TÍNH KHỐI LƯỢNG để kiểm tra minNotional/minQty
                        const capitalToUse = FIXED_USDT_AMOUNT_PER_TRADE;
                        const currentPrice = await getCurrentPrice(item.symbol);
                        if (currentPrice === null) {
                            addLog(`[DEBUG] Không thể lấy giá hiện tại cho ${item.symbol}. Bỏ qua.`);
                            continue;
                        }
                        let estimatedQuantity = (capitalToUse * symbolDetails.maxLeverage) / currentPrice;
                        estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                        estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                        const currentNotional = estimatedQuantity * currentPrice;

                        // Kiểm tra minNotional và minQty
                        if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                            eligibleCandidates.push({
                                symbol: item.symbol,
                                fundingRate: fundingRate,
                                nextFundingTime: nextFundingTimeMs,
                                maxLeverage: symbolDetails.maxLeverage
                            });
                        } else {
                            let reason = 'Không rõ';
                            if (currentNotional < symbolDetails.minNotional) reason = `Không đủ minNotional (${symbolDetails.minNotional.toFixed(2)} USDT)`;
                            else if (estimatedQuantity < symbolDetails.minQty) reason = `Khối lượng ước tính (${estimatedQuantity}) nhỏ hơn minQty (${symbolDetails.minQty})`;
                            addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), gần giờ funding, nhưng KHÔNG ĐỦ ĐIỀU KIỆN mở lệnh. Lý do: ${reason}.`);
                        }
                    } else {
                        addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), gần giờ funding, nhưng không tìm thấy thông tin đòn bẩy hoặc đòn bẩy <= 1 hoặc không có cấu hình TP. Bỏ qua.`);
                    }
                } else {
                    addLog(`[DEBUG] ${item.symbol}: Funding âm (${fundingRate}), nhưng KHÔNG GẦN giờ funding (còn ${timeToFundingMinutes.toFixed(1)} phút hoặc đã qua). Bỏ qua.`);
                }
            }
        }

        if (eligibleCandidates.length > 0) {
            // Sắp xếp ưu tiên: Funding rate âm nhất
            eligibleCandidates.sort((a, b) => a.fundingRate - b.fundingRate);

            let selectedCandidateToOpen = null; 

            // Duyệt qua các ứng viên đã sắp xếp (từ âm nhất)
            for (const candidate of eligibleCandidates) {
                const nowRefreshed = Date.now();
                
                // Tính toán thời điểm target để mở lệnh (1 giây trước giờ funding + offset)
                const targetOpenTimeMs = candidate.nextFundingTime - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
                const delayForExactOpenMs = targetOpenTimeMs - nowRefreshed;

                // Kiểm tra nếu thời điểm mở lệnh mong muốn còn ở tương lai và nằm trong cửa sổ cho phép chờ
                if (delayForExactOpenMs > 0 && delayForExactOpenMs <= (ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000)) {
                    selectedCandidateToOpen = candidate; 
                    break; // Tìm thấy ứng viên phù hợp, thoát vòng lặp
                } else {
                    addLog(`[DEBUG] Bỏ qua ${candidate.symbol} (Funding: ${candidate.fundingRate}, Giờ Funding: ${formatTimeUTC7(new Date(candidate.nextFundingTime))}). Thời điểm mở lệnh mong muốn (${formatTimeUTC7(new Date(targetOpenTimeMs))}) không nằm trong cửa sổ chờ hợp lệ (còn ${Math.ceil(delayForExactOpenMs / 1000)}s, max ${ONLY_OPEN_IF_FUNDING_IN_SECONDS}s).`, false);
                }
            }

            if (selectedCandidateToOpen) { 
                const nowFinal = Date.now(); 
                // Tính toán lại độ trễ cuối cùng trước khi đặt setTimeout
                const targetOpenTimeMs = selectedCandidateToOpen.nextFundingTime - (OPEN_TRADE_BEFORE_FUNDING_SECONDS * 1000) + OPEN_TRADE_AFTER_SECOND_OFFSET_MS;
                const delayForExactOpenMs = targetOpenTimeMs - nowFinal;

                if (delayForExactOpenMs <= 0) {
                    addLog(`⚠️ Đã quá thời điểm mở lệnh cho ${selectedCandidateToOpen.symbol}. Bỏ qua.`, true);
                    scheduleNextMainCycle();
                    return;
                }

                // ƯỚC TÍNH SỐ LƯỢNG CHO LOG ĐỂ HIỂN THỊ TRƯỚC
                const capitalToUse = FIXED_USDT_AMOUNT_PER_TRADE;
                const currentPrice = await getCurrentPrice(selectedCandidateToOpen.symbol);
                let estimatedQuantity = 0;
                if (currentPrice !== null && exchangeInfoCache[selectedCandidateToOpen.symbol]) {
                    const symbolInfo = exchangeInfoCache[selectedCandidateToOpen.symbol];
                    estimatedQuantity = (capitalToUse * selectedCandidateToOpen.maxLeverage) / currentPrice;
                    estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                    estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
                }

                addLog(`\n✅ Đã chọn đồng coin: **${selectedCandidateToOpen.symbol}**`, true);
                addLog(`  + Funding Rate: **${selectedCandidateToOpen.fundingRate}**`);
                addLog(`  + Giờ trả Funding tiếp theo: **${formatTimeUTC7(new Date(selectedCandidateToOpen.nextFundingTime))}**`);
                addLog(`  + Đòn bẩy tối đa: **${selectedCandidateToOpen.maxLeverage}x**`);
                addLog(`  + Số tiền dự kiến mở lệnh: **${capitalToUse.toFixed(2)} USDT** (Khối lượng ước tính: **${estimatedQuantity} ${selectedCandidateToOpen.symbol}**)`);
                addLog(`  + Lệnh sẽ được mở sau khoảng **${Math.ceil(delayForExactOpenMs / 1000)} giây** (vào lúc **${formatTimeUTC7(new Date(targetOpenTimeMs))}**).`, true);
                addLog(`>>> Đang chờ đến thời điểm mở lệnh chính xác...`, true);
                
                clearTimeout(nextScheduledTimeout); // Hủy lịch trình quét cũ để chờ mở lệnh
                nextScheduledTimeout = setTimeout(async () => {
                    if (!currentOpenPosition && botRunning) {
                        await openShortPosition(selectedCandidateToOpen.symbol, selectedCandidateToOpen.fundingRate, availableBalance, selectedCandidateToOpen.maxLeverage);
                    } else if (!botRunning) {
                        addLog('Bot đã bị dừng trong khi chờ mở lệnh. Hủy bỏ việc mở lệnh.', true);
                    } else {
                        addLog(`⚠️ Đã có vị thế được mở trong khi chờ (có thể do luồng khác). Bỏ qua việc mở lệnh mới.`, true);
                    }
                }, delayForExactOpenMs);
            } else { 
                addLog('>>> Không tìm thấy đồng coin nào thỏa mãn tất cả điều kiện để mở lệnh trong chu kỳ này. Đang chờ chu kỳ quét tiếp theo (vào phút :59).', true);
                scheduleNextMainCycle();
            }

        } else { 
            addLog('>>> Không tìm thấy cơ hội mở lệnh đủ điều kiện tại thời điểm này. Đang chờ chu kỳ quét tiếp theo (vào phút :59).', true);
            scheduleNextMainCycle();
        }
    } catch (error) {
        addLog('❌ Lỗi trong quá trình tìm kiếm cơ hội: ' + (error.msg || error.message), true);
        scheduleNextMainCycle(); // Nếu có lỗi, lên lịch lại để bot không bị dừng hoàn toàn
    }
}

// Hàm lên lịch chu kỳ chính của bot (quét hoặc chờ đến phút :59)
async function scheduleNextMainCycle() {
    if (!botRunning) {
        addLog('Bot đã dừng. Không lên lịch chu kỳ mới.', true);
        clearTimeout(nextScheduledTimeout);
        return;
    }

    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bot sẽ không lên lịch quét mới mà chờ đóng vị thế hiện tại.', true);
        // manageOpenPosition sẽ tự động gọi scheduleNextMainCycle sau khi đóng vị thế
        return; 
    }

    clearTimeout(nextScheduledTimeout); // Xóa bất kỳ lịch trình cũ nào

    const now = Date.now();
    const currentMinute = new Date(now).getUTCMinutes(); 
    let delayUntilNext59Minute;

    if (currentMinute < 59) {
        // Nếu đang ở phút < 59, chờ đến phút 59 của giờ hiện tại
        delayUntilNext59Minute = (59 - currentMinute) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    } else {
        // Nếu đang ở phút 59 hoặc sau 59, chờ đến phút 59 của giờ tiếp theo
        delayUntilNext59Minute = (60 - currentMinute + 59) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    }

    // Đảm bảo delay không âm hoặc quá nhỏ
    if (delayUntilNext59Minute <= 0) {
        delayUntilNext59Minute = 1000; // Chờ ít nhất 1 giây để tránh lỗi setTimeout với giá trị 0
    }

    const nextScanMoment = new Date(now + delayUntilNext59Minute);

    addLog(`>>> Bot đang đi uống bia sẽ trở lại lúc **${formatTimeUTC7(nextScanMoment)}**).`, true);

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) {
            await runTradingLogic();
        } else {
            addLog('Bot đã bị dừng trong khi chờ. Không tiếp tục chu kỳ.', true);
        }
    }, delayUntilNext59Minute);
}

// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot logic hiện đang chạy. Không cần khởi động lại.', true);
        return 'Bot logic hiện đang chạy.';
    }

    addLog('--- Khởi động Bot ---', true);
    addLog('>>> Đang kiểm tra kết nối API Key với Binance Futures...', true);

    try {
        await syncServerTime(); // Đồng bộ thời gian trước khi kiểm tra API

        // Kiểm tra API Key bằng cách lấy thông tin tài khoản
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key hoạt động bình thường! Số dư USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`, true);

        // Load exchange info một lần khi khởi động bot
        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Lỗi load thông tin sàn (exchangeInfo). Bot sẽ dừng.', true);
            return 'Không thể load thông tin sàn (exchangeInfo).';
        }

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`, true);

        // Bắt đầu chu kỳ chính của bot (quét hoặc chờ)
        scheduleNextMainCycle();

        // Thiết lập kiểm tra vị thế định kỳ (dù không có lệnh vẫn chạy để đảm bảo quản lý)
        if (!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) { // Chỉ chạy nếu bot đang chạy và có vị thế mở
                    await manageOpenPosition();
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval); // Nếu bot dừng, clear interval này
                    positionCheckInterval = null;
                }
            }, 1000); // Kiểm tra mỗi giây
        }
        startCountdownFrontend(); // Khởi động bộ đếm ngược frontend ngay khi bot bắt đầu

        return 'Bot đã khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('❌ [Lỗi nghiêm trọng khi khởi động bot] ' + errorMsg, true);
        addLog('   -> Bot sẽ dừng hoạt động. Vui lòng kiểm tra và khởi động lại.', true);
       
        botRunning = false; 
        return `Lỗi khi khởi động bot: ${errorMsg}`;
    }
}

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

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();

// Phục vụ file index.html từ thư mục hiện tại của script
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint để lấy log từ file PM2
app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi khi đọc file log:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy file log: ${BOT_LOG_FILE}. Vui lòng đảm bảo đường dẫn chính xác và PM2 đang chạy bot với log đầu ra đúng.`);
            }
            return res.status(500).send('Lỗi khi đọc file log');
        }
        // Xóa các ký tự màu sắc ANSI để hiển thị sạch hơn trên trình duyệt
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        res.send(cleanData);
    });
});

// API endpoint để lấy trạng thái bot từ PM2 và trạng thái nội bộ
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
            statusMessage = `Trạng thái Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME})`;
        }
        res.send(statusMessage);
    } catch (error) {
        console.error('Lỗi khi lấy trạng thái PM2:', error);
        res.status(500).send(`Trạng thái Bot: Lỗi khi lấy trạng thái. (${error})`);
    }
});

// API endpoint để lấy thông báo đếm ngược cho frontend
app.get('/api/countdown', (req, res) => {
    res.send(currentCountdownMessage);
});

// API endpoint để khởi động bot logic chính (nội bộ, không phải PM2)
app.get('/start_bot_logic', async (req, res) => {
    const message = await startBotLogicInternal();
    res.send(message);
});

// API endpoint để dừng bot logic chính (nội bộ, không phải PM2)
app.get('/stop_bot_logic', (req, res) => {
    const message = stopBotLogicInternal();
    res.send(message);
});

// Khởi động Web Server
app.listen(WEB_SERVER_PORT, () => {
    addLog(`Web server đang chạy trên cổng ${WEB_SERVER_PORT}`, true);
    addLog(`Truy cập giao diện: http://localhost:${WEB_SERVER_PORT} (hoặc IP của bạn)`, true);
    // Tự động khởi động bot logic khi server web bắt đầu (tùy chọn)
    // startBotLogicInternal(); 
});
