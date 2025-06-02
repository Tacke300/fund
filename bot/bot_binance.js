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
let nextScheduledTimeout = null; 

// Biến và interval cho việc hiển thị đếm ngược trên giao diện web
let currentCountdownMessage = "Không có lệnh đang chờ đóng.";
let countdownIntervalFrontend = null; 

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
// Số dư USDT tối thiểu trong ví futures để bot được phép mở lệnh
const MIN_USDT_BALANCE_TO_OPEN = 0.1; 

// SỐ PHẦN TRĂM CỦA TÀI KHOẢN USDT KHẢ DỤNG SẼ DÙNG CHO MỖI LỆNH ĐẦU TƯ BAN ĐẦU.
// Ví dụ: 0.01 = 1% của số dư USDT khả dụng.
// ĐẢM BẢO GIÁ TRỊ NÀY ĐỦ LỚN ĐỂ KHI ĐƯỢC TÍNH TOÁN, NÓ VƯỢT QUA minNotional CỦA SÀN.
// Nếu 1% quá nhỏ (ví dụ: 1% của 10 USDT là 0.1 USDT), bot sẽ không thể mở lệnh.
const PERCENT_ACCOUNT_PER_TRADE = 0.5; // Ví dụ: 0.01 = 1%

// Cấu hình Stop Loss:
// SL cố định X% của vốn đầu tư ban đầu (số tiền được tính từ PERCENT_ACCOUNT_PER_TRADE)
const STOP_LOSS_PERCENTAGE = 0.05; // 0.5 = 50% của vốn đầu tư ban đầu

// Bảng ánh xạ maxLeverage với Take Profit percentage.
// TP được tính dựa trên X% của vốn đầu tư ban đầu (số tiền được tính từ PERCENT_ACCOUNT_PER_TRADE).
// Đã điều chỉnh để phù hợp với việc giữ lệnh 10 giây (giá trị TP có thể rất nhỏ hoặc không thể đạt)
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.15,  // 5% TP nếu đòn bẩy 20x
    25: 0.15,  // 6% TP nếu đòn bẩy 25x
    50: 0.18,  // 8% TP nếu đòn bẩy 50x
    75: 0.2,  // 10% TP nếu đòn bẩy 75x
    100: 0.25, // 12% TP nếu đòn bẩy 100x
    125: 0.33, // 15% TP nếu đòn bẩy 125x
};

// Ngưỡng funding rate âm tối thiểu để xem xét mở lệnh (ví dụ: -0.005 = -0.5%)
const MIN_FUNDING_RATE_THRESHOLD = -0.0001; 
// Thời gian tối đa giữ một vị thế (ví dụ: 90 giây = 1 phút 30 giây)
// ĐÃ SỬA ĐỔI THÀNH 10 GIÂY THEO YÊU CẦU
const MAX_POSITION_LIFETIME_SECONDS = 180; 

// Cửa sổ thời gian (tính bằng phút) TRƯỚC giờ funding mà bot sẽ bắt đầu quét.
// Đặt là 1 phút để chỉ quét vào phút :59.
const FUNDING_WINDOW_MINUTES = 1; 

// Chỉ mở lệnh nếu thời gian còn lại đến funding <= X giây.
// Đặt là 60 để đảm bảo chỉ mở trong phút :59.
const ONLY_OPEN_IF_FUNDING_IN_SECONDS = 60; 

// Thời gian (giây) TRƯỚC giờ funding chính xác mà bot sẽ cố gắng đặt lệnh.
// Đặt là 1 để cố gắng mở lệnh vào giây :59.
const OPEN_TRADE_BEFORE_FUNDING_SECONDS = 1; 
// Thời gian (mili giây) LỆNH so với giây :59 để mở lệnh (để tránh quá tải).
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
    } else if (method === 'DELETE') { 
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json'; 
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

/**
 * Thiết lập chế độ ký quỹ (MARGIN_TYPE) cho một symbol.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @param {string} marginType - Chế độ ký quỹ ('ISOLATED' hoặc 'CROSSED').
 * @returns {boolean} True nếu thành công, false nếu thất bại.
 */
async function setMarginType(symbol, marginType) {
    try {
        addLog(`[DEBUG] Đang thiết lập chế độ ký quỹ ${marginType} cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/marginType', 'POST', {
            symbol: symbol,
            marginType: marginType
        });
        addLog(`✅ Đã thiết lập chế độ ký quỹ ${marginType} cho ${symbol}.`);
        return true;
    } catch (error) {
        // Xử lý lỗi -4046: "No need to change margin type" (đã là chế độ mong muốn)
        if (error.code === -4046 && error.msg === 'No need to change margin type.') {
            addLog(`⚠️ Chế độ ký quỹ ${marginType} cho ${symbol} đã được thiết lập. Tiếp tục.`, true);
            return true; // Coi như thành công vì đã ở chế độ mong muốn
        }
        addLog(`❌ Lỗi khi thiết lập chế độ ký quỹ ${marginType} cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return false;
    }
}

/**
 * Lấy chế độ ký quỹ hiện tại cho một symbol.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @returns {string|null} 'ISOLATED', 'CROSSED', hoặc null nếu lỗi.
 */
async function getMarginType(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/positionRisk', 'GET');
        const symbolPosition = response.find(p => p.symbol === symbol);
        if (symbolPosition) {
            return symbolPosition.marginType;
        }
        return null;
    } catch (error) {
        addLog(`❌ Lỗi khi lấy chế độ ký quỹ cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return null;
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

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`>>> Đang hủy tất cả các lệnh mở cho ${symbol}...`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`✅ Đã hủy thành công tất cả các lệnh mở cho ${symbol}.`);
        return true;
    } catch (error) {
        if (error.code === -2011 && error.msg === 'Unknown order sent.') {
            addLog(`⚠️ Không có lệnh mở nào để hủy cho ${symbol}.`);
            return true; // Coi như thành công vì không có gì để hủy
        }
        addLog(`❌ Lỗi khi hủy lệnh mở cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return false;
    }
}

/**
 * Lấy tất cả các lệnh mở (open orders) cho một symbol.
 * @param {string} symbol - Symbol của cặp giao dịch.
 * @returns {Array} Danh sách các lệnh mở.
 */
async function getOpenOrders(symbol) {
    try {
        const orders = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: symbol });
        return orders;
    } catch (error) {
        addLog(`❌ Lỗi khi lấy lệnh mở cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return [];
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
        // Sử dụng khối lượng thực tế trên sàn để đảm bảo đóng chính xác
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
            
            // HỦY TẤT CẢ LỆNH CHƯA KHỚP SAU KHI ĐÓNG VỊ THẾ
            await cancelOpenOrdersForSymbol(symbol);

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
        
        // HỦY TẤT CẢ LỆNH CHƯA KHỚP SAU KHI ĐÓNG VỊ THẾ
        await cancelOpenOrdersForSymbol(symbol);

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
                currentCountdownMessage = `Vị thế ${currentOpenPosition.symbol}: Đã vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đang chờ đóng.`;
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
        
        // 1. Kiểm tra và thiết lập chế độ ký quỹ CROSSED nếu chưa phải là CROSSED
        const currentMarginType = await getMarginType(symbol);
        if (currentMarginType !== 'CROSSED') {
            const setMarginTypeSuccess = await setMarginType(symbol, 'CROSSED'); 
            if (!setMarginTypeSuccess) {
                addLog(`❌ Không thể cài đặt chế độ ký quỹ CROSSED cho ${symbol}. Hủy mở lệnh.`, true);
                if(botRunning) scheduleNextMainCycle();
                return;
            }
        } else {
            addLog(`[DEBUG] Chế độ ký quỹ cho ${symbol} đã là CROSSED. Không cần thay đổi.`);
        }

        // 2. Thiết lập đòn bẩy
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

        // Tính toán số vốn (USD) sẽ dùng cho mỗi lệnh (đây là số tiền ký quỹ ban đầu giả định)
        const initialMargin = usdtBalance * PERCENT_ACCOUNT_PER_TRADE; 

        if (usdtBalance < initialMargin) {
            addLog(`⚠️ Số dư USDT khả dụng (${usdtBalance.toFixed(2)}) không đủ để mở lệnh với ${initialMargin.toFixed(2)} USDT ký quỹ. Hủy mở lệnh.`, true);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        // Tính toán khối lượng lệnh dựa trên initialMargin và đòn bẩy
        // Khối lượng = (Số tiền ký quỹ * Đòn bẩy) / Giá hiện tại
        let quantity = (initialMargin * maxLeverage) / currentPrice; 

        // Làm tròn quantity theo stepSize và quantityPrecision của sàn
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        // Đảm bảo quantity không nhỏ hơn minQty
        if (quantity < minQty) {
            addLog(`⚠️ Khối lượng tính toán (${quantity.toFixed(quantityPrecision)}) nhỏ hơn minQty (${minQty}) cho ${symbol}. Không thể mở lệnh.`, true);
            addLog(`   Vui lòng tăng PERCENT_ACCOUNT_PER_TRADE hoặc chọn cặp có minQty nhỏ hơn.`);
            if(botRunning) scheduleNextMainCycle(); 
            return;
        }

        // Tính toán giá trị hợp đồng (notional) và đảm bảo nó lớn hơn minNotional
        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Giá trị hợp đồng (${currentNotional.toFixed(pricePrecision)} USDT) quá nhỏ so với minNotional (${minNotional} USDT) cho ${symbol}. Không thể mở lệnh.`, true);
            addLog(`   Vốn USDT đầu tư: ${initialMargin.toFixed(2)} USDT. Vị thế ước tính (đòn bẩy ${maxLeverage}x): ${currentNotional.toFixed(2)} USDT.`);
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
        addLog(`  + Chế độ ký quỹ: CROSSED`); 
        addLog(`  + Đòn bẩy: ${maxLeverage}x`);
        addLog(`  + Ký quỹ ban đầu ước tính: ${initialMargin.toFixed(2)} USDT`); 
        addLog(`  + Khối lượng: ${quantity} ${symbol}`);
        addLog(`  + Giá vào lệnh: ${entryPrice.toFixed(pricePrecision)}`);

        // Tính toán TP/SL ban đầu dựa trên initialMargin
        const slAmountUSDT = initialMargin * STOP_LOSS_PERCENTAGE; 
        const tpPercentage = TAKE_PROFIT_PERCENTAGES[maxLeverage]; 
        const tpAmountUSDT = initialMargin * tpPercentage; 

        // Tính toán giá SL (giá tăng lên so với giá vào lệnh)
        let slPrice = entryPrice + (slAmountUSDT / quantity);
        // Tính toán giá TP (giá giảm xuống so với giá vào lệnh)
        let tpPrice = entryPrice - (tpAmountUSDT / quantity);

        // Làm tròn TP/SL theo tickSize của sàn
        slPrice = Math.ceil(slPrice / tickSize) * tickSize; 
        tpPrice = Math.floor(tpPrice / tickSize) * tickSize; 

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`>>> Giá TP: ${tpPrice.toFixed(pricePrecision)}, Giá SL: ${slPrice.toFixed(pricePrecision)}`, true);
        addLog(`   (SL: ${(STOP_LOSS_PERCENTAGE * 100).toFixed(0)}% của ${initialMargin.toFixed(2)} USDT = ${slAmountUSDT.toFixed(2)} USDT)`); 
        addLog(`   (TP: ${(tpPercentage * 100).toFixed(0)}% của ${initialMargin.toFixed(2)} USDT = ${tpAmountUSDT.toFixed(2)} USDT)`);


        // ĐẶT LỆNH TP VÀ SL BẰNG STOP_MARKET VÀ TAKE_PROFIT_MARKET NGAY SAU KHI VỊ THẾ MỞ
        // Cần kiểm tra giá TP/SL có hợp lệ không (ví dụ: không kích hoạt ngay lập tức)
        // Lỗi "Order would immediately trigger" là do giá quá gần.
        // Bạn có thể cân nhắc một khoảng đệm nhỏ hoặc logic retry nếu cần.
        try {
            // Lệnh Stop Loss (Mua để đóng vị thế Short khi giá tăng)
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: 'BUY', 
                type: 'STOP_MARKET', 
                quantity: quantity, 
                stopPrice: slPrice, 
                closePosition: 'true', // Đảm bảo lệnh này đóng vị thế
                newOrderRespType: 'FULL'
            });
            addLog(`✅ Đã đặt lệnh STOP_MARKET (SL) cho ${symbol} tại giá ${slPrice.toFixed(pricePrecision)}.`, true);
        } catch (slError) {
            addLog(`❌ Lỗi khi đặt lệnh SL cho ${symbol}: ${slError.msg || slError.message}. SL có thể không được đặt.`, true);
        }

        try {
            // Lệnh Take Profit (Mua để đóng vị thế Short khi giá giảm)
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: 'BUY', 
                type: 'TAKE_PROFIT_MARKET', 
                quantity: quantity, 
                stopPrice: tpPrice, 
                closePosition: 'true', // Đảm bảo lệnh này đóng vị thế
                newOrderRespType: 'FULL'
            });
            addLog(`✅ Đã đặt lệnh TAKE_PROFIT_MARKET (TP) cho ${symbol} tại giá ${tpPrice.toFixed(pricePrecision)}.`, true);
        } catch (tpError) {
            addLog(`❌ Lỗi khi đặt lệnh TP cho ${symbol}: ${tpError.msg || tpError.message}. TP có thể không được đặt.`, true);
        }


        // Lưu thông tin vị thế đang mở
        currentOpenPosition = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            initialTPPrice: tpPrice, 
            initialSLPrice: slPrice, 
            initialMargin: initialMargin, 
            openTime: openTime,
            pricePrecision: pricePrecision,
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
            }, 300); // Đặt interval này 300ms để chạy liên tục
        }
        startCountdownFrontend(); // Bắt đầu bộ đếm ngược trên frontend

    } catch (error) {
        addLog(`❌ Lỗi mở SHORT ${symbol}: ${error.msg || error.message}`, true);
        if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ để tìm cơ hội mới
    }
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở (SL/TP/Timeout)
 * Đã loại bỏ hoàn toàn logic TP/SL tầng 2
 */
async function manageOpenPosition() {
    // Nếu không có vị thế hoặc đang trong quá trình đóng, thoát
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) { 
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            stopCountdownFrontend(); 
            if(botRunning) scheduleNextMainCycle(); // Quay lại chu kỳ chính nếu không có vị thế
        }
        return;
    }

    const { symbol, quantity, openTime } = currentOpenPosition; 

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        // ƯU TIÊN KIỂM TRA HẾT THỜI GIAN ĐỂ ĐÓNG VỊ THẾ
        if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`⏱️ Vị thế ${symbol} vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`, true);
            await closeShortPosition(symbol, quantity, 'Hết thời gian');
            return; 
        }
        
        // Kiểm tra vị thế thực tế trên Binance để đảm bảo cập nhật trạng thái
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) < 0);
        
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> Vị thế ${symbol} đã đóng trên sàn (có thể do TP/SL được kích hoạt). Cập nhật trạng thái bot.`, true);
            currentOpenPosition = null;
            if (positionCheckInterval) {
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
            stopCountdownFrontend();
            // HỦY TẤT CẢ CÁC LỆNH CHƯA KHỚP (SL/TP còn lại)
            await cancelOpenOrdersForSymbol(symbol);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        // Không cần checkAndClosePositionManually nữa vì TP/SL sẽ được xử lý bởi STOP_MARKET/TAKE_PROFIT_MARKET
        // và lệnh sẽ đóng theo MAX_POSITION_LIFETIME_SECONDS.

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
        
        // Tính toán số vốn sẽ dùng cho mỗi lệnh dựa trên phần trăm tài khoản
        const estimatedCapitalToUse = availableBalance * PERCENT_ACCOUNT_PER_TRADE;

        // Kiểm tra số dư đủ để vào lệnh với số tiền tính toán
        // MIN_USDT_BALANCE_TO_OPEN được dùng làm ngưỡng tối thiểu cho estimatedCapitalToUse
        if (availableBalance < estimatedCapitalToUse || estimatedCapitalToUse < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) không đủ để mở lệnh với ${(PERCENT_ACCOUNT_PER_TRADE*100).toFixed(2)}% tài khoản (${estimatedCapitalToUse.toFixed(2)} USDT) hoặc số tiền này quá nhỏ (<${MIN_USDT_BALANCE_TO_OPEN} USDT). Không thể mở lệnh.`, true);
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
                        const capitalToUseForEstimate = availableBalance * PERCENT_ACCOUNT_PER_TRADE;
                        const currentPrice = await getCurrentPrice(item.symbol);
                        if (currentPrice === null) {
                            addLog(`[DEBUG] Không thể lấy giá hiện tại cho ${item.symbol}. Bỏ qua.`);
                            continue;
                        }
                        
                        let estimatedQuantity = (capitalToUseForEstimate * symbolDetails.maxLeverage) / currentPrice;
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
                const capitalToUseForLog = availableBalance * PERCENT_ACCOUNT_PER_TRADE;
                const currentPrice = await getCurrentPrice(selectedCandidateToOpen.symbol);
                let estimatedQuantity = 0;
                if (currentPrice !== null && exchangeInfoCache[selectedCandidateToOpen.symbol]) {
                    const symbolInfo = exchangeInfoCache[selectedCandidateToOpen.symbol];
                    estimatedQuantity = (capitalToUseForLog * selectedCandidateToOpen.maxLeverage) / currentPrice;
                    estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                    estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
                }

                addLog(`\n✅ Đã chọn đồng coin: ${selectedCandidateToOpen.symbol}`, true);
                addLog(`  + Funding Rate: ${selectedCandidateToOpen.fundingRate}`);
                addLog(`  + Giờ trả Funding tiếp theo: ${formatTimeUTC7(new Date(selectedCandidateToOpen.nextFundingTime))}`);
                addLog(`  + Đòn bẩy tối đa: ${selectedCandidateToOpen.maxLeverage}x`);
                addLog(`  + Số tiền dự kiến mở lệnh: ${capitalToUseForLog.toFixed(2)} USDT (Khối lượng ước tính: ${estimatedQuantity} ${selectedCandidateToOpen.symbol})`);
                addLog(`  + Lệnh sẽ được mở sau khoảng ${Math.ceil(delayForExactOpenMs / 1000)} giây (vào lúc ${formatTimeUTC7(new Date(targetOpenTimeMs))}).`, true);
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

    addLog(`>>> Bot đang đi uống bia sẽ trở lại lúc ${formatTimeUTC7(nextScanMoment)}.`);

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

        // Thiết lập kiểm tra vị thế định kỳ
        if (!positionCheckInterval) { 
            positionCheckInterval = setInterval(async () => {
                // Kiểm tra currentOpenPosition trước khi gọi manageOpenPosition
                if (botRunning && currentOpenPosition) { 
                    await manageOpenPosition();
                } else if (!botRunning && positionCheckInterval) {
                    // Nếu bot dừng hoặc không có vị thế, clear interval này
                    clearInterval(positionCheckInterval); 
                    positionCheckInterval = null;
                }
            }, 300); // Kiểm tra mỗi 300ms
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
