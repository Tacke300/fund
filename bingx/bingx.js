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
// SỬ DỤNG API KEY VÀ SECRET KEY CỦA BINGX, KHÔNG PHẢI BINANCE!
const API_KEY = 'WhRrdudEgBMTiFnTiqrZe2LlNGeK68lcMAZhOyn0AY00amysW5ep2LJ45smFxONwoIE0l72b4zc5muDGw'.trim();     // <--- THAY THẾ BẰNG API KEY THẬT CỦA BINGX
const SECRET_KEY = 'AiRyJvGCVIDNVPQkBYo2WaxdgzbJlkGQvmvJmPXET5JTyqcZxThb16a2kZNU7M5LKLJicA2hLtckejMtyFzPA'.trim(); // <--- THAY THẾ BẰNG SECRET KEY THẬT CỦA BINGX

// === BASE URL CỦA BINGX SWAP V2 API ===
const BASE_HOST = 'open-api-swap.bingx.com'; // Futures/Swap API Host
const BASE_PATH = '/openApi/swap/v2'; // Base path for Swap V2 API

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
const CAPITAL_PERCENTAGE_PER_TRADE = 0.5; // Phần trăm vốn sử dụng cho mỗi lệnh (50% tài khoản)

// Cấu hình TP/SL theo yêu cầu mới
const STOP_LOSS_PERCENTAGE = 0.70; // SL cố định 70% của vốn đầu tư ban đầu

// Bảng ánh xạ maxLeverage với Take Profit percentage
// Đảm bảo các giá trị đòn bẩy được định nghĩa ở đây.
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.23,
    25: 0.28,
    50: 0.56,
    75: 0.86,
    100: 1.08,
    125: 1.36,
};

// ĐÃ SỬA: Ngưỡng funding rate âm tối thiểu để xem xét (từ -0.0002 xuống -0.002)
const MIN_FUNDING_RATE_THRESHOLD = -0.003; 
const MAX_POSITION_LIFETIME_SECONDS = 180; // Thời gian tối đa giữ một vị thế (180 giây = 3 phút)

// Thời gian trước giờ funding mà bot sẽ xem xét mở lệnh (đơn vị: phút)
// Sử dụng để lọc sơ bộ các đồng coin.
const FUNDING_WINDOW_MINUTES = 30; 

// Ngưỡng thời gian còn lại (tính bằng giây) để bot coi là "sắp trả funding" và tiến hành mở lệnh.
// Chỉ mở lệnh nếu nextFundingTime của đồng coin được chọn còn lại <= X giây.
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 179; // Ví dụ: chỉ mở nếu còn lại <= 2 phút

// Cấu hình thời gian quét bot
// Bot sẽ quét định kỳ, không cố định vào phút :58 nữa.
// Thay vào đó, nó sẽ tự động tính toán thời gian quét dựa trên nextFundingTime của các đồng coin.
// Ví dụ: mỗi 1 phút bot sẽ kiểm tra xem có đồng nào sắp đến giờ funding trong window không.
// const SCAN_INTERVAL_SECONDS = 60; // Quét mỗi 60 giây (đã bị ghi đè bởi logic phút :58)
// Giữ lại logic quét vào phút :58 như yêu cầu ban đầu.

// === Cấu hình Server Web ===
const WEB_SERVER_PORT = 3000; // Cổng cho giao diện web
// Đường dẫn tới file log của PM2 cho bot này (để web server đọc)
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/bot-bingx-out.log'; // Đổi tên log file cho BingX
const THIS_BOT_PM2_NAME = 'bot_bingx'; // Đổi tên PM2 process cho BingX

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

// Hàm tạo chữ ký HMAC SHA256 cho BingX
// BingX yêu cầu chuỗi ký là: uri_path + request_body + apiKey + secretKey
// Và các headers: X-BX-APIKEY, X-BX-SIGN, X-BX-TIMESTAMP (hoặc X-BX-TS)
function createBingXSignature(uriPath, requestBody, apiKey, apiSecret, timestamp) {
    // requestBody cần là chuỗi query string hoặc body dạng x-www-form-urlencoded
    const signPayload = `${uriPath}${requestBody}${apiKey}${timestamp}`;
    return crypto.createHmac('sha256', apiSecret)
                        .update(signPayload)
                        .digest('hex');
}

// Hàm gửi HTTP request
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

// Hàm gọi API có chữ ký cho BingX
async function callSignedAPI(endpointPath, method = 'GET', params = {}) {
    const timestamp = Date.now() + serverTimeOffset; // Sử dụng offset để đồng bộ thời gian

    let queryString = Object.keys(params)
                                    .map(key => `${key}=${params[key]}`)
                                    .join('&');
    
    // BingX yêu cầu body khi ký, ngay cả với GET nếu có params
    const requestBodyForSignature = queryString; 

    const signature = createBingXSignature(BASE_PATH + endpointPath, requestBodyForSignature, API_KEY, SECRET_KEY, timestamp);

    let requestPath;
    const headers = {
        'X-BX-APIKEY': API_KEY,
        'X-BX-SIGN': signature,
        'X-BX-TIMESTAMP': timestamp, // Hoặc X-BX-TS
        'Content-Type': 'application/json', // BingX thường dùng JSON cho POST/PUT, nhưng GET vẫn có thể dùng form-urlencoded
    };

    if (method === 'GET') {
        requestPath = `${BASE_PATH}${endpointPath}` + (queryString ? `?${queryString}` : '');
    } else if (method === 'POST') {
        requestPath = `${BASE_PATH}${endpointPath}`;
        // Đối với POST, body sẽ là JSON hoặc form-urlencoded. BingX thường yêu cầu JSON cho body.
        // Tuy nhiên, tài liệu lại bảo ký với body là queryString, nên chúng ta sẽ gửi queryString làm body nếu là POST và có params
        // Nếu API thực tế yêu cầu JSON body, đoạn này cần điều chỉnh
        headers['Content-Type'] = 'application/x-www-form-urlencoded'; // Mặc định dùng form-urlencoded cho body, để khớp với cách ký
    } else {
        throw new Error(`Unsupported method: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, (method === 'POST' && queryString) ? queryString : '');
        const response = JSON.parse(rawData);
        if (response.code !== 0) { // BingX thường trả về code 0 là thành công
            throw { code: response.code, msg: response.msg || 'Unknown BingX API Error' };
        }
        return response.data; // Dữ liệu thực tế nằm trong trường 'data'
    } catch (error) {
        addLog("❌ Lỗi khi gửi yêu cầu ký tới BingX API:");
        addLog(`  Mã lỗi: ${error.code || 'UNKNOWN'}`);
        addLog(`  Thông báo: ${error.msg || error.message || 'Lỗi không xác định'}`);
        if (error.code === 40001 || error.code === 40003) { // Authentication issues
            addLog("  Gợi ý: Lỗi xác thực API Key/Secret. Vui lòng kiểm tra lại API_KEY, SECRET_KEY và quyền truy cập Swap/Futures của bạn.");
        } else if (error.code === 40002) { // Timestamp invalid
            addLog("  Gợi ý: Lỗi lệch thời gian. Đảm bảo đồng hồ máy tính của bạn chính xác hoặc nếu vẫn gặp lỗi, hãy báo lại để chúng ta thêm cơ chế đồng bộ thời gian nâng cao.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

// Hàm gọi API công khai cho BingX
async function callPublicAPI(endpointPath, params = {}) {
    const queryString = Object.keys(params)
                                    .map(key => `${key}=${params[key]}`)
                                    .join('&');
    const fullPathWithQuery = `${BASE_PATH}${endpointPath}` + (queryString ? `?${queryString}` : '');

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        const response = JSON.parse(rawData);
        if (response.code !== 0) {
            throw { code: response.code, msg: response.msg || 'Unknown BingX API Error' };
        }
        return response.data; // Dữ liệu thực tế nằm trong trường 'data'
    } catch (error) {
        addLog("❌ Lỗi khi gửi yêu cầu công khai tới BingX API:");
        addLog(`  Mã lỗi: ${error.code || 'UNKNOWN'}`);
        addLog(`  Thông báo: ${error.msg || error.message || 'Lỗi không xác định'}`);
        if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của BingX.");
        } else if (error.code === 'NETWORK_ERROR') {
            addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

// Hàm lấy thời gian server BingX (dùng endpoint /user/ping)
async function syncServerTime() {
    try {
        const data = await callPublicAPI('/user/ping'); // Endpoint là /user/ping
        const bingxServerTime = data.timestamp; // BingX trả về trong trường 'timestamp'
        const localTime = Date.now();
        serverTimeOffset = bingxServerTime - localTime;
        addLog(`✅ Đồng bộ thời gian với BingX server. Độ lệch: ${serverTimeOffset} ms.`, true);
    } catch (error) {
        addLog(`❌ Lỗi khi đồng bộ thời gian với BingX: ${error.message}.`, true);
        serverTimeOffset = 0; // Đặt về 0 nếu không đồng bộ được để tránh lỗi timestamp
    }
}

// Hàm lấy thông tin đòn bẩy cho một symbol
// BingX không có endpoint leverageBracket riêng lẻ như Binance.
// Thông tin leverage nằm trong market/contracts
async function getLeverageBracketForSymbol(symbol) {
    try {
        // ExchangeInfo đã chứa maxLeverage
        const symbolInfo = await getExchangeInfo();
        if (symbolInfo && symbolInfo[symbol] && symbolInfo[symbol].maxLeverage) {
            const maxLev = parseInt(symbolInfo[symbol].maxLeverage);
            return maxLev;
        }
        addLog(`[DEBUG getLeverageBracketForSymbol] Không tìm thấy thông tin đòn bẩy hợp lệ cho ${symbol}.`);
        return null;
    } catch (error) {
        addLog(`❌ Lỗi lấy đòn bẩy cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Hàm lấy thông tin sàn (exchangeInfo) từ BingX /market/contracts
async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    addLog('>>> Đang lấy exchangeInfo từ BingX...', true);
    try {
        const data = await callPublicAPI('/market/contracts'); // Endpoint là /market/contracts
        addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.length}`, true);

        exchangeInfoCache = {};
        data.forEach(s => {
            if (s.symbol.endsWith('USDT') && s.status === 'TRADING') { // Chỉ lấy cặp USDT và đang TRADING
                exchangeInfoCache[s.symbol] = {
                    minQty: parseFloat(s.minTradeQuantity),
                    maxQty: parseFloat(s.maxTradeQuantity), // MaxTradeQuantity có thể là string
                    stepSize: parseFloat(s.tradeUnit), // tradeUnit là step size
                    minNotional: parseFloat(s.minTradeAmount), // minTradeAmount là minNotional
                    pricePrecision: parseInt(s.pricePrecision), // pricePrecision
                    quantityPrecision: parseInt(s.quantityPrecision), // quantityPrecision
                    minPrice: 0, // Không có minPrice/maxPrice rõ ràng như Binance, có thể bỏ qua hoặc đặt 0/Infinity
                    maxPrice: Infinity,
                    tickSize: parseFloat(s.priceTick), // priceTick là tickSize
                    maxLeverage: parseFloat(s.maxLeverage), // maxLeverage nằm trực tiếp ở đây
                    // BingX có thể có thêm info khác, ví dụ feeRate
                };
            }
        });
        addLog('>>> Đã tải thông tin sàn và cache.', true);
        return exchangeInfoCache;
    } catch (error) {
        addLog('❌ Lỗi khi lấy exchangeInfo: ' + (error.msg || error.message), true);
        exchangeInfoCache = null;
        return null;
    }
}

// Hàm kết hợp để lấy tất cả filters và maxLeverage (sử dụng exchangeInfoCache)
async function getSymbolFiltersAndMaxLeverage(symbol) {
    const filters = await getExchangeInfo();

    if (!filters || !filters[symbol]) {
        addLog(`[DEBUG getSymbolFiltersAndMaxLeverage] Không tìm thấy filters cho ${symbol}.`);
        return null;
    }

    // maxLeverage đã có trong exchangeInfoCache
    return {
        ...filters[symbol]
    };
}

// Hàm lấy giá hiện tại từ BingX /market/ticker
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/market/ticker', { symbol: symbol }); // Endpoint là /market/ticker
        if (data && data.ticker && data.ticker.lastPrice) {
            const price = parseFloat(data.ticker.lastPrice); // BingX trả về trong data.ticker.lastPrice
            return price;
        }
        addLog(`⚠️ Không tìm thấy giá cho ${symbol} trong phản hồi /market/ticker.`);
        return null;
    } catch (error) {
        addLog(`❌ Lỗi khi lấy giá cho ${symbol}: ` + (error.msg || error.message));
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

        // Kiểm tra vị thế thực tế trên BingX
        const positions = await callSignedAPI('/position/openPositions', 'GET'); // Endpoint là /position/openPositions
        const currentPositionOnBingX = positions.find(p => p.symbol === symbol);

        if (!currentPositionOnBingX || parseFloat(currentPositionOnBingX.holding) === 0) { // BingX dùng 'holding' cho khối lượng
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

        // Gửi lệnh đóng (BUY MARKET)
        // BingX yêu cầu side là 'BUY' để đóng short, type là 'MARKET', action là 'CLOSE_POSITION'
        addLog(`[DEBUG] Gửi lệnh đóng SHORT: symbol=${symbol}, side=BUY, type=MARKET, quantity=${adjustedQuantity}, action=CLOSE_POSITION`);

        await callSignedAPI('/trade/order', 'POST', { // Endpoint là /trade/order
            symbol: symbol,
            side: 'BUY',
            type: 'MARKET',
            volume: adjustedQuantity.toString(), // BingX dùng 'volume' thay cho 'quantity' và yêu cầu là string
            action: 'CLOSE_POSITION' // BingX yêu cầu action để đóng vị thế
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
async function openShortPosition(symbol, fundingRate, usdtBalance) {
    if (currentOpenPosition) {
        addLog(`⚠️ Đã có vị thế đang mở (${currentOpenPosition.symbol}). Bỏ qua việc mở lệnh mới cho ${symbol}.`);
        if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ nếu bot đang chạy
        return;
    }

    addLog(`>>> Đang mở lệnh SHORT ${symbol} với Funding Rate: ${fundingRate}`, true);
    try {
        // 1. Lấy thông tin symbol và đòn bẩy
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo || typeof symbolInfo.maxLeverage !== 'number' || symbolInfo.maxLeverage <= 1) {
            addLog(`❌ Không thể lấy thông tin đòn bẩy ${symbol}. Không mở lệnh.`, true);
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
        // BingX không có endpoint riêng để điều chỉnh đòn bẩy trước khi đặt lệnh như Binance.
        // Đòn bẩy được chọn khi đặt lệnh, hoặc điều chỉnh margin mode, leverage trong settings.
        // Giả định bot đang giao dịch ở chế độ Cross/Isolated với đòn bẩy mặc định hoặc đã cài đặt thủ công.
        // Nếu cần đặt đòn bẩy qua API, cần tìm endpoint 'trade/setLeverage' và gọi nó.
        // Hiện tại, bỏ qua bước này vì bot không có API đặt đòn bẩy tường minh trước khi mở lệnh.
        // addLog(`[DEBUG] Đang thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}. (Nếu BingX có API hỗ trợ)`);
        // await callSignedAPI('/trade/setLeverage', 'POST', { symbol: symbol, leverage: maxLeverage }); // Ví dụ endpoint
        // addLog(`✅ Đã thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);

        // BingX API có endpoint /trade/setLeverage, cần xem tài liệu để dùng đúng.
        // "V1 API: openApi/swap/v1/trade/setLeverage"
        // "V2 API: openApi/swap/v2/trade/setLeverage"
        addLog(`[DEBUG] Đang thiết lập đòn bẩy ${maxLeverage}x cho ${symbol} qua API.`);
        try {
            await callSignedAPI('/trade/setLeverage', 'POST', {
                symbol: symbol,
                leverage: maxLeverage,
                marginMode: 'ISOLATED' // Có thể là CROSS hoặc ISOLATED
            });
            addLog(`✅ Đã thiết lập đòn bẩy ${maxLeverage}x cho ${symbol} ở chế độ ISOLATED.`);
        } catch (setLeverageError) {
            addLog(`❌ Lỗi khi thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}: ${setLeverageError.msg || setLeverageError.message}. Tiếp tục mở lệnh với đòn bẩy hiện tại (nếu có).`);
            // Nếu không thể đặt đòn bẩy, bot có thể dừng hoặc tiếp tục với đòn bẩy hiện tại.
            // Để đảm bảo an toàn, tốt hơn là dừng nếu không thể đặt đòn bẩy mong muốn.
            // Để đơn giản, bot sẽ cố gắng tiếp tục, nhưng người dùng cần lưu ý.
            if(botRunning) scheduleNextMainCycle();
            return;
        }


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
        // BingX: side='SELL', type='MARKET', volume=quantity, action='OPEN_POSITION'
        const orderResult = await callSignedAPI('/trade/order', 'POST', {
            symbol: symbol,
            side: 'SELL',
            type: 'MARKET',
            volume: quantity.toString(), // Yêu cầu là string
            action: 'OPEN_POSITION' // Cần action để mở vị thế
        });

        const entryPrice = parseFloat(orderResult.averagePrice || currentPrice); // BingX dùng averagePrice
        const openTime = new Date();
        const formattedOpenTime = `${openTime.toLocaleDateString('en-GB')} ${openTime.toLocaleTimeString('en-US', { hour12: false })}.${String(openTime.getMilliseconds()).padStart(3, '0')}`;

        addLog(`✅ Đã mở SHORT ${symbol} vào lúc ${formattedOpenTime}`, true);
        addLog(`  + Funding Rate: ${fundingRate}`);
        addLog(`  + Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Số tiền: ${capitalToUse.toFixed(2)} USDT`);
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

    addLog('>>> Đang quét cơ hội mở lệnh (chỉ vào phút :58)...', true);
    try {
        // Lấy thông tin tài khoản BingX
        const accountInfo = await callSignedAPI('/user/account', 'GET'); // Endpoint là /user/account
        // BingX trả về balance trong accountInfo.data.balance. Vẫn cần tìm USDT
        let usdtAsset = 0;
        if (accountInfo && Array.isArray(accountInfo.balances)) { // Trong user/account, balances là mảng
            const usdtBalanceInfo = accountInfo.balances.find(b => b.asset === 'USDT');
            if (usdtBalanceInfo) {
                usdtAsset = parseFloat(usdtBalanceInfo.availableBalance); // availableBalance
            }
        }
        const availableBalance = parseFloat(usdtAsset);

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu (${MIN_USDT_BALANCE_TO_OPEN}). Tắt điện thoại đi uống bia đê`, true);
            scheduleNextMainCycle();
            return;
        }

        // Lấy funding rate từ BingX /market/fundingRate
        const allFundingData = await callPublicAPI('/market/fundingRate'); // Endpoint là /market/fundingRate
        const now = Date.now();

        let eligibleCandidates = []; // Danh sách các đồng coin thỏa mãn điều kiện cơ bản

        for (const item of allFundingData) {
            const fundingRate = parseFloat(item.fundingRate); // BingX dùng 'fundingRate'
            // BingX trả về nextFundingTime là timestamp, chính xác rồi
            const nextFundingTimeMs = item.nextFundingTime; 
            
            // Điều kiện 1: Funding rate đủ âm và là cặp USDT (item.symbol đã là USDT theo getExchangeInfo)
            // BingX API /market/fundingRate không trả về trực tiếp symbol, mà là contractId
            // Tuy nhiên, nếu dùng contracts (exchangeInfo) thì sẽ có symbol
            // Giả định item ở đây đã là một đối tượng có symbol và phù hợp
            // Cần ánh xạ contractId từ /market/fundingRate với symbol trong exchangeInfo
            const symbolFromContractId = exchangeInfoCache ? Object.values(exchangeInfoCache).find(s => s.symbol === item.symbol) : null;
            if (!symbolFromContractId || !item.symbol.endsWith('USDT')) { // Kiểm tra lại symbol
                continue; // Bỏ qua nếu không phải cặp USDT hoặc không tìm thấy symbol trong cache
            }

            if (fundingRate < MIN_FUNDING_RATE_THRESHOLD) {
                // Điều kiện 2: nextFundingTime của đồng coin này phải còn trong cửa sổ xem xét
                const timeToFundingMs = nextFundingTimeMs - now;
                const timeToFundingMinutes = timeToFundingMs / (1000 * 60);

                // Lọc sơ bộ để chỉ xem xét các coin sắp đến giờ funding
                // Kiểm tra nếu thời gian còn lại đến funding lớn hơn 0 (chưa qua)
                // VÀ nhỏ hơn hoặc bằng FUNDING_WINDOW_MINUTES (ví dụ: 30 phút)
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
                                nextFundingTime: nextFundingTimeMs, // Sử dụng nextFundingTime trực tiếp
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
                const nowRefreshed = Date.now(); // Lấy lại thời gian hiện tại để đảm bảo chính xác
                const timeToOpenMs = candidate.nextFundingTime - nowRefreshed;
                const delayForExactOpenMs = timeToOpenMs + 100; // Đợi thêm 100ms sau giờ funding

                // Kiểm tra điều kiện "sắp trả funding" hợp lệ cho CHÍNH ĐỒNG COIN ĐÓ:
                // 1. Còn thời gian để chờ (delayForExactOpenMs > 0)
                // 2. Thời gian chờ thực tế đến funding (timeToOpenMs) phải rất gần (<= ONLY_OPEN_IF_FUNDING_IN_SECONDS)
                // 3. Giờ funding của nó chưa qua (timeToOpenMs >= 0)
                if (delayForExactOpenMs > 0 && timeToOpenMs <= (ONLY_OPEN_IF_FUNDING_IN_SECONDS * 1000) && timeToOpenMs >= 0) {
                    selectedCandidateToOpen = candidate; // Tìm thấy ứng viên phù hợp
                    break; // Thoát vòng lặp, chúng ta đã tìm được đồng coin âm nhất và sắp trả funding
                } else {
                    addLog(`[DEBUG] Bỏ qua ${candidate.symbol} (Funding: ${candidate.fundingRate}, Giờ Funding: ${formatTimeUTC7(new Date(candidate.nextFundingTime))}, còn ${Math.ceil(timeToOpenMs / 1000)}s) - không phải đồng coin sắp trả funding trong cửa sổ mở lệnh (còn > ${ONLY_OPEN_IF_FUNDING_IN_SECONDS}s). Tiếp tục xét đồng khác.`, false);
                }
            }

            if (selectedCandidateToOpen) { // Nếu tìm được một ứng viên thực sự phù hợp để mở lệnh
                const nowFinal = Date.now(); // Lấy lại thời gian cuối cùng trước khi tính toán
                const timeToOpenMs = selectedCandidateToOpen.nextFundingTime - nowFinal;
                const delayForExactOpenMs = timeToOpenMs + 100;

                const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
                const currentPrice = await getCurrentPrice(selectedCandidateToOpen.symbol);
                let estimatedQuantity = 0;
                if (currentPrice !== null) {
                    estimatedQuantity = (capitalToUse * selectedCandidateToOpen.maxLeverage) / currentPrice;
                    const symbolInfo = exchangeInfoCache[selectedCandidateToOpen.symbol];
                    if (symbolInfo) {
                        estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                        estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
                    }
                }

                addLog(`\n✅ Đã chọn đồng coin: **${selectedCandidateToOpen.symbol}**`, true);
                addLog(`  + Funding Rate: **${selectedCandidateToOpen.fundingRate}**`);
                addLog(`  + Giờ trả Funding tiếp theo (tính toán): **${formatTimeUTC7(new Date(selectedCandidateToOpen.nextFundingTime))}**`);
                addLog(`  + Đòn bẩy tối đa: **${selectedCandidateToOpen.maxLeverage}x**`);
                addLog(`  + Số tiền dự kiến mở lệnh: **${capitalToUse.toFixed(2)} USDT** (Khối lượng ước tính: **${estimatedQuantity} ${selectedCandidateToOpen.symbol}**)`);
                addLog(`  + Lệnh sẽ được mở sau khoảng **${Math.ceil(delayForExactOpenMs / 1000)} giây** (vào lúc **${formatTimeUTC7(new Date(selectedCandidateToOpen.nextFundingTime + 100))}**).`, true);

                addLog(`>>> Đang chờ đến thời điểm mở lệnh chính xác...`, true);
                clearTimeout(nextScheduledTimeout); // Hủy lịch trình quét :58 nếu có
                nextScheduledTimeout = setTimeout(async () => {
                    if (!currentOpenPosition && botRunning) {
                        addLog(`>>> Đã đến giờ funding cho ${selectedCandidateToOpen.symbol}. Đang thực hiện mở lệnh.`, true);
                        await openShortPosition(selectedCandidateToOpen.symbol, selectedCandidateToOpen.fundingRate, availableBalance);
                    } else if (!botRunning) {
                        addLog('Bot đã bị dừng trong khi chờ. Hủy bỏ việc mở lệnh.', true);
                    } else {
                        addLog(`⚠️ Đã có vị thế được mở trong khi chờ (bởi luồng khác). Bỏ qua việc mở lệnh mới.`, true);
                    }
                }, delayForExactOpenMs);
            } else { // Không tìm thấy đồng coin nào phù hợp sau khi duyệt qua tất cả
                addLog('>>> Không tìm thấy đồng coin nào thỏa mãn cả điều kiện funding âm và sắp trả funding trong chu kỳ này. Đang chờ chu kỳ quét tiếp theo (vào phút :58).', true);
                scheduleNextMainCycle();
            }

        } else { // Không có đồng coin nào đạt điều kiện sơ bộ
            addLog('>>> Không tìm thấy cơ hội mở lệnh đủ điều kiện tại thời điểm này. Đang chờ chu kỳ quét tiếp theo (vào phút :58).', true);
            scheduleNextMainCycle();
        }
    } catch (error) {
        addLog('❌ Lỗi tìm kiếm: ' + (error.msg || error.message), true);
        scheduleNextMainCycle(); // Lên lịch quét lại nếu có lỗi
    }
}

// Hàm lên lịch chu kỳ chính của bot (quét hoặc chờ)
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
    let delayUntilNext58Minute;

    if (currentMinute < 58) {
        // Nếu đang ở phút < 58, chờ đến phút 58 của giờ hiện tại
        delayUntilNext58Minute = (58 - currentMinute) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    } else {
        // Nếu đang ở phút 58 hoặc sau 58, chờ đến phút 58 của giờ tiếp theo
        delayUntilNext58Minute = (60 - currentMinute + 58) * 60 * 1000 - new Date(now).getUTCSeconds() * 1000 - new Date(now).getUTCMilliseconds();
    }

    // Đảm bảo delay không âm (ví dụ: nếu chạy lúc 58:00:00, delay phải rất nhỏ)
    if (delayUntilNext58Minute <= 0) {
        delayUntilNext58Minute = 1000; // Chờ ít nhất 1 giây để tránh lỗi setTimeout với giá trị 0
    }

    const nextScanMoment = new Date(now + delayUntilNext58Minute);

    addLog(`>>> Bot đang đi uống bia sẽ trở lại lúc **${formatTimeUTC7(nextScanMoment)}**).`, true);

    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) {
            await runTradingLogic();
        } else {
            addLog('Bot đã bị dừng.', true);
        }
    }, delayUntilNext58Minute);
}

// --- Hàm khởi động bot logic chính (nội bộ, không phải PM2 start) ---
async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot logic hiện đang chạy. Không cần khởi động lại.', true);
        return 'Bot logic hiện đang chạy.';
    }

    addLog('--- Khởi động Bot ---', true);
    addLog('>>> Đang kiểm tra kết nối API Key với BingX Swap...', true);

    try {
        await syncServerTime(); // Đồng bộ thời gian trước

        // Kiểm tra API Key bằng cách lấy thông tin tài khoản
        const account = await callSignedAPI('/user/account', 'GET');
        const usdtBalanceInfo = account.balances.find(a => a.asset === 'USDT');
        const usdtBalance = usdtBalanceInfo ? usdtBalanceInfo.availableBalance : 0;
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

        let statusMessage = 'MÁY CHỦ: ĐI TẮT (PM2)';
        if (botProcess) {
            statusMessage = `MÁY CHỦ: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                statusMessage += ` | TRẠNG THÁI: ${botRunning ? 'ĐANG CHẠY' : 'ĐÃ DỪNG'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    statusMessage += ` | ĐÃ CHẠY: ${uptimeMinutes} phút`;
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
