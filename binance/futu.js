import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } = from 'url';

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

// Biến cờ điều khiển trạng thái bot (chạy/dừng)
let botRunning = false;
let botStartTime = null; // Thời điểm bot được khởi động lại

// Biến để lưu trữ setInterval cho việc kiểm tra vị thế đang mở
let positionMonitorInterval = null; 
// Biến để lưu trữ setTimeout cho lần chạy tiếp theo của chu kỳ chính (nếu có)
let nextScheduledTimeout = null; 

// Biến và interval cho việc hiển thị đếm ngược trên giao diện web (SẼ CHUYỂN THÀNH HIỂN THỊ TRẠNG THÁI LỆNH)
let currentDisplayMessage = "Bot đang chờ lệnh đầu tiên.";
let displayUpdateIntervalFrontend = null; 

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
const SYMBOL = 'ETHUSDT'; // Đồng coin áp dụng chiến lược này (hoặc BTCUSDT)
const INITIAL_TRADE_AMOUNT_USDT = 0.2; // Số USD ban đầu cho lệnh đầu tiên (ví dụ: 1$)

// Cấu hình Stop Loss và Take Profit
// TP mặc định cho tất cả lệnh = 125% vốn của lệnh đó
const TAKE_PROFIT_PERCENTAGE = 1.25; 
// SL mặc định cho tất cả lệnh = 80% vốn của lệnh đó
const STOP_LOSS_PERCENTAGE = 0.8; 

// Đòn bẩy cố định cho tất cả các lệnh
const LEVERAGE = 125; // Ví dụ: 20x

// Vòng lặp nếu lỗ 6 lần liên tiếp => trở lại mức ban đầu
const MAX_CONSECUTIVE_LOSSES = 6;

// --- BIẾN THEO DÕI TRẠNG THÁI CHIẾN LƯỢC ---
let currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT; // Vốn cho lệnh hiện tại
let currentTradeDirection = 'LONG'; // Hướng của lệnh hiện tại ('LONG' hoặc 'SHORT')
let consecutiveLosses = 0; // Đếm số lệnh lỗ liên tiếp

// Lưu trữ thông tin lệnh đang mở
// Bổ sung orderId để theo dõi lệnh đã đặt SL/TP
let currentTradeDetails = null; // { symbol, quantity, entryPrice, side, initialTradeAmountUSDT, initialTPPrice, initialSLPrice, orderId_open, orderId_sl, orderId_tp }

// --- CẤU HÌNH WEB SERVER VÀ LOG PM2 ---
const WEB_SERVER_PORT = 3333; // Cổng cho giao diện web đã đổi thành 3333
// Đường dẫn tới file log của PM2 cho bot này.
// Đảm bảo đường dẫn này chính xác với cấu hình PM2 của bạn (thường là ~/.pm2/logs/<tên_app>-out.log)
const BOT_LOG_FILE = '/home/tacke300/.pm2/logs/futu-out.log'; // Tên log file đã đổi theo tên PM2 mới
// Tên của bot trong PM2, phải khớp với tên bạn đã dùng khi start bot bằng PM2.
const THIS_BOT_PM2_NAME = 'futu'; // Tên PM2 đã đổi thành futu

// === HÀM TIỆN ÍCH ===

function addLog(message, isImportant = false) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    let logEntry = `[${time}] ${message}`;

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
                    addLog(`❌ HTTP Request lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`❌ Network lỗi: ${e.message}`);
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
        requestBody = `${queryString}&signature=${signature}`; // DELETE cũng có thể dùng body hoặc query, tùy API. Binance thường dùng Query.
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Method không hỗ trợ: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        return JSON.parse(rawData);
    } catch (error) {
        addLog(`❌ Lỗi ký API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
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
        addLog(`❌ Lỗi công khai API Binance: ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
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
        addLog(`✅ Đồng bộ thời gian. Lệch: ${serverTimeOffset} ms.`, true);
    } catch (error) {
        addLog(`❌ Lỗi đồng bộ thời gian: ${error.message}.`, true);
        serverTimeOffset = 0;
        throw error;
    }
}

// Lấy thông tin sàn (exchangeInfo) và cache lại
async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    addLog('>>> Lấy exchangeInfo...', true);
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        addLog(`✅ Đã nhận exchangeInfo. Symbols: ${data.symbols.length}`, true);

        exchangeInfoCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            exchangeInfoCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0.001), // Use minQty for market_lot_size if stepSize missing
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
            };
        });
        addLog('>>> Đã tải thông tin sàn.', true);
        return exchangeInfoCache;
    } catch (error) {
        addLog('❌ Lỗi lấy exchangeInfo: ' + (error.msg || error.message), true);
        exchangeInfoCache = null;
        throw error;
    }
}

// Hàm kết hợp để lấy tất cả filters cho một symbol
async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        addLog(`[DEBUG] Không tìm thấy filters cho ${symbol}.`);
        return null;
    }
    return filters[symbol];
}

// Lấy giá hiện tại của một symbol
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
        return parseFloat(data.price);
    } catch (error) {
        addLog(`❌ Lỗi khi lấy giá cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

/**
 * Hủy tất cả các lệnh mở cho một symbol cụ thể.
 * @param {string} symbol - Symbol của cặp giao dịch.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        addLog(`>>> Hủy lệnh mở cho ${symbol}...`);
        // Binance API cho phép hủy tất cả lệnh mở bằng cách không truyền orderId
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol: symbol });
        addLog(`✅ Đã hủy lệnh mở cho ${symbol}.`);
        return true;
    } catch (error) {
        if (error.code === -2011) { // -2011: No orders exist for this symbol.
            addLog(`⚠️ Không có lệnh mở cho ${symbol}.`);
            return true;
        }
        addLog(`❌ Lỗi hủy lệnh mở cho ${symbol}: ${error.code} - ${error.msg || error.message}`);
        return false;
    }
}

// Thiết lập đòn bẩy cho một symbol
async function setLeverage(symbol, leverage) {
    try {
        addLog(`[DEBUG] Đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: leverage
        });
        addLog(`✅ Đã đặt đòn bẩy ${leverage}x cho ${symbol}.`);
        return true;
    } catch (error) {
        // Lỗi nếu đòn bẩy đã được đặt rồi có thể bỏ qua
        if (error.code === -4011 || error.msg.includes('No need to change')) {
            addLog(`⚠️ Đòn bẩy đã được đặt ${leverage}x cho ${symbol}.`);
            return true;
        }
        addLog(`❌ Lỗi đặt đòn bẩy ${leverage}x cho ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}

/**
 * Đóng vị thế hiện tại và mở một vị thế mới dựa trên kết quả của lệnh trước.
 * @param {boolean} isProfit - True nếu lệnh trước lãi, False nếu lỗ.
 */
async function closeAndOpenNewPosition(isProfit) {
    addLog(`\n--- Bắt đầu chu kỳ mới: ${isProfit ? 'LÃI' : 'LỖ'} ---`, true);
    currentDisplayMessage = `Lệnh trước: ${isProfit ? 'LÃI' : 'LỖ'}. Đang chuẩn bị lệnh mới...`;

    const symbol = SYMBOL;
    
    // --- 1. Hủy tất cả các lệnh mở hiện tại (bao gồm cả TP/SL còn sót lại) ---
    await cancelOpenOrdersForSymbol(symbol);
    
    // --- 2. Kiểm tra và đóng vị thế hiện có trên sàn (nếu có vị thế sót) ---
    // Điều này quan trọng nếu bot bị dừng đột ngột và có vị thế mở mà chưa được đóng bởi TP/SL
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (openPositionOnBinance) {
            const positionAmt = parseFloat(openPositionOnBinance.positionAmt);
            const sideToClose = positionAmt > 0 ? 'SELL' : 'BUY'; // Nếu positionAmt > 0 (LONG), thì SELL để đóng. Ngược lại.
            const quantityToClose = Math.abs(positionAmt);
            const symbolInfo = await getSymbolDetails(symbol);

            if (!symbolInfo) {
                addLog(`❌ Lỗi lấy symbol info ${symbol}. Không thể đóng vị thế sót.`, true);
                // Vẫn tiếp tục để mở lệnh mới nếu có thể
            } else {
                // Đảm bảo quantity khớp với precision của sàn
                const adjustedQuantityToClose = parseFloat(quantityToClose.toFixed(symbolInfo.quantityPrecision));

                addLog(`>>> Phát hiện vị thế đang mở trên sàn: ${positionAmt} ${symbol}. Đang đóng...`);
                
                await callSignedAPI('/fapi/v1/order', 'POST', {
                    symbol: symbol,
                    side: sideToClose,
                    type: 'MARKET',
                    quantity: adjustedQuantityToClose,
                    reduceOnly: 'true' // Đảm bảo lệnh này chỉ dùng để đóng vị thế, không mở thêm
                });
                addLog(`✅ Đã đóng vị thế ${positionAmt} ${symbol} trên sàn.`, true);
                await delay(1000); // Đợi 1 giây để lệnh market khớp hoàn toàn
                await cancelOpenOrdersForSymbol(symbol); // Hủy lại đảm bảo không còn lệnh chờ nào sau khi đóng
            }
        } else {
            addLog(`>>> Không có vị thế mở nào của ${symbol} trên sàn.`, true);
        }
    } catch (error) {
        addLog(`❌ Lỗi khi cố gắng đóng vị thế hiện có trên sàn: ${error.code} - ${error.msg || error.message}`);
        // Tiếp tục logic, nhưng ghi nhận lỗi
    }

    // --- 3. Cập nhật trạng thái và chuẩn bị cho lệnh mới ---
    if (isProfit) {
        consecutiveLosses = 0; // Reset số lệnh lỗ liên tiếp
        currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT; // Vốn trở lại ban đầu
        // currentTradeDirection KHÔNG ĐỔI nếu lãi (theo yêu cầu "mở 1 lệnh cùng chiều vị thế hiện tại").
        // Nếu lệnh ban đầu là Long, và nó lãi, lệnh tiếp theo là Long.
        // Nếu lệnh Long ban đầu lỗ, thành Short. Nếu Short này lãi, lệnh tiếp theo là Short.
        
        addLog(`✅ Lệnh trước đã lãi. Vốn mới: ${currentTradeAmountUSDT.toFixed(2)} USDT. Chiều: ${currentTradeDirection}.`, true);
    } else { // Lỗ
        consecutiveLosses++;
        if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
            addLog(`⚠️ Đã lỗ ${consecutiveLosses} lần liên tiếp. Reset về vốn ban đầu và chiều LONG.`, true);
            currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT;
            currentTradeDirection = 'LONG'; // Reset về Long
            consecutiveLosses = 0; // Reset lại số lệnh lỗ liên tiếp
        } else {
            currentTradeAmountUSDT *= 1.3; // Gấp đôi vốn
            currentTradeDirection = (currentTradeDirection === 'LONG' ? 'SHORT' : 'LONG'); // Đảo chiều
            addLog(`❌ Lệnh trước đã lỗ. Vốn mới: ${currentTradeAmountUSDT.toFixed(2)} USDT (gấp đôi). Chiều: ${currentTradeDirection}.`, true);
        }
    }
    
    // Reset currentTradeDetails để mở lệnh mới
    currentTradeDetails = null;

    // --- 4. Thực hiện lệnh mới ---
    try {
        addLog(`>>> Mở lệnh ${currentTradeDirection} cho ${symbol} với vốn ${currentTradeAmountUSDT.toFixed(2)} USDT...`, true);
        await openNewPosition(symbol, currentTradeAmountUSDT, currentTradeDirection);
        currentDisplayMessage = `Lệnh mới: ${currentTradeDirection} ${symbol}, Vốn: ${currentTradeAmountUSDT.toFixed(2)} USDT.`;
    } catch (error) {
        addLog(`❌ Lỗi khi mở lệnh mới: ${error.msg || error.message}. Bot tạm dừng.`, true);
        currentDisplayMessage = `Lỗi mở lệnh: ${error.msg || error.message}. Bot dừng.`;
        stopBotLogicInternal();
    }
    addLog(`\n--- Kết thúc chu kỳ. Chờ kiểm tra vị thế... ---`, true);
}


/**
 * Mở một vị thế mới (Long/Short) với số vốn đã tính toán.
 * @param {string} symbol - Cặp giao dịch (ví dụ: 'BTCUSDT').
 * @param {number} tradeAmountUSDT - Số vốn USDT để mở lệnh.
 * @param {string} side - Hướng lệnh ('LONG' hoặc 'SHORT').
 */
async function openNewPosition(symbol, tradeAmountUSDT, side) {
    try {
        await setLeverage(symbol, LEVERAGE); // Đặt đòn bẩy

        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`❌ Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`, true);
            throw new Error('Không thể lấy chi tiết symbol.');
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true);
            throw new Error('Không thể lấy giá hiện tại.');
        }
        addLog(`[DEBUG] Giá ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // Tính toán số lượng (quantity) dựa trên vốn, đòn bẩy và giá hiện tại
        let quantity = (tradeAmountUSDT * LEVERAGE) / currentPrice;
        // Làm tròn quantity theo stepSize của sàn (để đảm bảo tính hợp lệ)
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        // Kiểm tra các điều kiện tối thiểu của sàn
        if (quantity < minQty || (quantity * currentPrice) < minNotional || quantity <= 0) {
            addLog(`⚠️ Qty (${quantity.toFixed(quantityPrecision)}) hoặc Notional (${(quantity * currentPrice).toFixed(pricePrecision)}) không đủ điều kiện cho ${symbol}. Hủy.`, true);
            throw new Error('Số lượng hoặc giá trị không hợp lệ theo quy định sàn.');
        }

        const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: orderSide,
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' // Yêu cầu đầy đủ thông tin để lấy orderId và giá khớp
        });

        // Lấy giá vào lệnh thực tế (avgFillPrice) hoặc dùng giá thị trường nếu không có avgFillPrice
        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice);
        addLog(`✅ Đã mở lệnh ${side} ${symbol} với ${quantity} Qty @ ${entryPrice.toFixed(pricePrecision)}.`);

        // Tính toán SL/TP dựa trên phần trăm vốn và đòn bẩy
        let slPrice, tpPrice;
        
        if (side === 'LONG') {
            // SL: Giá giảm 80% vốn / đòn bẩy. TP: Giá tăng 125% vốn / đòn bẩy
            slPrice = entryPrice * (1 - STOP_LOSS_PERCENTAGE / LEVERAGE); 
            tpPrice = entryPrice * (1 + TAKE_PROFIT_PERCENTAGE / LEVERAGE); 
        } else { // SHORT
            // SL: Giá tăng 80% vốn / đòn bẩy. TP: Giá giảm 125% vốn / đòn bẩy
            slPrice = entryPrice * (1 + STOP_LOSS_PERCENTAGE / LEVERAGE);
            tpPrice = entryPrice * (1 - TAKE_PROFIT_PERCENTAGE / LEVERAGE);
        }

        // Đảm bảo TP/SL nằm ngoài giá vào để tránh bị kích hoạt ngay lập tức (phòng trường hợp tính toán sai số nhỏ)
        // Đây chỉ là một biện pháp an toàn nhỏ, không nên xảy ra với công thức trên
        if (side === 'LONG') {
            if (slPrice >= entryPrice) slPrice = entryPrice * 0.99; 
            if (tpPrice <= entryPrice) tpPrice = entryPrice * 1.01;
        } else { // SHORT
            if (slPrice <= entryPrice) slPrice = entryPrice * 1.01;
            if (tpPrice >= entryPrice) tpPrice = entryPrice * 0.99;
        }

        // Làm tròn giá TP/SL theo tickSize của sàn
        // SL (Stop Market): giá phải chạm hoặc vượt qua để kích hoạt
        // TP (Take Profit Market): giá phải chạm hoặc vượt qua để kích hoạt
        // Đối với Long: SL nên được làm tròn xuống (để chắc chắn giá chạm stopPrice nếu giá giảm), TP làm tròn xuống (để chắc chắn giá chạm stopPrice nếu giá tăng)
        // Đối với Short: SL nên được làm tròn lên, TP làm tròn lên
        if (side === 'LONG') {
            slPrice = Math.floor(slPrice / tickSize) * tickSize; // làm tròn xuống
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize; // làm tròn xuống
        } else { // SHORT
            slPrice = Math.ceil(slPrice / tickSize) * tickSize; // làm tròn lên
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize; // làm tròn lên
        }
        
        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`>>> Đặt TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

        let orderId_sl = null;
        let orderId_tp = null;

        // Đặt lệnh SL (STOP_MARKET để đóng vị thế nếu giá chạm)
        try {
            const slOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: (side === 'LONG' ? 'SELL' : 'BUY'), // Ngược chiều lệnh gốc
                type: 'STOP_MARKET',
                quantity: quantity,
                stopPrice: slPrice,
                closePosition: 'true', // Chỉ định lệnh này để đóng vị thế
                newOrderRespType: 'FULL'
            });
            orderId_sl = slOrderResult.orderId;
            addLog(`✅ Đã đặt SL cho ${symbol} @ ${slPrice.toFixed(pricePrecision)}. Order ID: ${orderId_sl}`);
        } catch (slError) {
            addLog(`❌ Lỗi đặt SL cho ${symbol}: ${slError.msg || slError.message}. Tiếp tục mà không có SL.`, true);
        }

        // Đặt lệnh TP (TAKE_PROFIT_MARKET để đóng vị thế nếu giá đạt mục tiêu)
        try {
            const tpOrderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol: symbol,
                side: (side === 'LONG' ? 'SELL' : 'BUY'), // Ngược chiều lệnh gốc
                type: 'TAKE_PROFIT_MARKET',
                quantity: quantity,
                stopPrice: tpPrice, // Với TAKE_PROFIT_MARKET, stopPrice là giá kích hoạt
                closePosition: 'true', // Chỉ định lệnh này để đóng vị thế
                newOrderRespType: 'FULL'
            });
            orderId_tp = tpOrderResult.orderId;
            addLog(`✅ Đã đặt TP cho ${symbol} @ ${tpPrice.toFixed(pricePrecision)}. Order ID: ${orderId_tp}`);
        } catch (tpError) {
            addLog(`❌ Lỗi đặt TP cho ${symbol}: ${tpError.msg || tpError.message}. Tiếp tục mà không có TP.`, true);
        }

        // Lưu thông tin lệnh vào biến trạng thái toàn cục
        currentTradeDetails = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            side: side,
            initialTradeAmountUSDT: tradeAmountUSDT,
            initialTPPrice: tpPrice,
            initialSLPrice: slPrice,
            orderId_open: orderResult.orderId, // Lưu Order ID của lệnh mở vị thế ban đầu
            orderId_sl: orderId_sl,
            orderId_tp: orderId_tp,
            pricePrecision: pricePrecision, // Lưu lại để dùng khi hiển thị PnL
            quantityPrecision: quantityPrecision
        };

    } catch (error) {
        addLog(`❌ Lỗi mở lệnh ${side} ${symbol}: ${error.msg || error.message}`, true);
        throw error;
    }
}

/**
 * Hàm kiểm tra và quản lý vị thế đang mở.
 * Sẽ gọi `closeAndOpenNewPosition` khi TP/SL khớp hoặc vị thế đã đóng.
 */
async function monitorCurrentPosition() {
    if (!botRunning) {
        return;
    }

    if (!currentTradeDetails) {
        currentDisplayMessage = "Bot đang chờ lệnh đầu tiên hoặc đã kết thúc chu kỳ.";
        return;
    }

    const { symbol, quantity, orderId_sl, orderId_tp } = currentTradeDetails;
    // Cập nhật trạng thái hiển thị
    currentDisplayMessage = `Đang theo dõi: ${currentTradeDetails.side} ${symbol} Qty: ${quantity}. Vốn: ${currentTradeAmountUSDT.toFixed(2)} USDT. Lỗ liên tiếp: ${consecutiveLosses}.`;

    try {
        // Lấy trạng thái của các lệnh TP/SL đã đặt (nếu có)
        let slOrderStatus = null;
        let tpOrderStatus = null;

        if (orderId_sl) {
            try {
                const slOrder = await callSignedAPI('/fapi/v1/order', 'GET', { symbol: symbol, orderId: orderId_sl });
                slOrderStatus = slOrder.status; // status có thể là NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED
            } catch (err) {
                if (err.code === -2013) slOrderStatus = 'CANCELLED_OR_FILLED'; // Order not found: có thể đã bị hủy hoặc đã khớp và bị xóa khỏi danh sách
                else addLog(`❌ Lỗi kiểm tra trạng thái SL order ${orderId_sl}: ${err.msg || err.message}`);
            }
        }
        if (orderId_tp) {
            try {
                const tpOrder = await callSignedAPI('/fapi/v1/order', 'GET', { symbol: symbol, orderId: orderId_tp });
                tpOrderStatus = tpOrder.status;
            } catch (err) {
                if (err.code === -2013) tpOrderStatus = 'CANCELLED_OR_FILLED';
                else addLog(`❌ Lỗi kiểm tra trạng thái TP order ${orderId_tp}: ${err.msg || err.message}`);
            }
        }

        // Kiểm tra vị thế thực tế trên sàn để đảm bảo không còn vị thế mở
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (!openPositionOnBinance || Math.abs(parseFloat(openPositionOnBinance.positionAmt)) < (quantity * 0.05)) { // Vị thế đã đóng hoặc giảm đáng kể (<5% lượng ban đầu)
            addLog(`>>> Vị thế ${symbol} đã đóng hoặc giảm số lượng đáng kể. Đang xác định kết quả...`, true);
            
            // Hủy các lệnh SL/TP còn lại (nếu có) để tránh lỗi hoặc các lệnh không mong muốn
            await cancelOpenOrdersForSymbol(symbol);

            let isProfit = false;

            // Ưu tiên kiểm tra PnL thực tế từ lịch sử giao dịch gần nhất
            try {
                const pnlResult = await callSignedAPI('/fapi/v2/income', 'GET', {
                    symbol: symbol,
                    incomeType: 'REALIZED_PNL',
                    startTime: new Date(Date.now() - (5 * 60 * 1000)).getTime(), // Lấy PnL trong 5 phút gần nhất
                    limit: 5 // Lấy vài record để đối chiếu nếu cần
                });
                
                if (pnlResult && pnlResult.length > 0) {
                    // Lấy PnL gần nhất sau khi lệnh đóng
                    const latestPnlEntry = pnlResult.sort((a,b) => b.time - a.time)[0]; // Sắp xếp giảm dần theo thời gian
                    addLog(`[DEBUG] Latest REALIZED_PNL from API: ${latestPnlEntry.income} (Time: ${formatTimeUTC7(new Date(latestPnlEntry.time))})`);
                    isProfit = parseFloat(latestPnlEntry.income) > 0;
                } else {
                    addLog(`[DEBUG] Không có REALIZED_PNL nào được tìm thấy trong lịch sử gần đây.`);
                    // Nếu không có PnL thực tế, dựa vào trạng thái của lệnh SL/TP
                    if (tpOrderStatus === 'FILLED' || (tpOrderStatus === 'CANCELLED_OR_FILLED' && (slOrderStatus === 'NEW' || slOrderStatus === null))) {
                        // Nếu TP khớp hoặc TP bị hủy (và SL không khớp/không tồn tại) -> coi là lãi
                        isProfit = true;
                        addLog(`[DEBUG] TP order (${orderId_tp}) khớp hoặc đã bị hủy/thực hiện. Coi là LÃI.`);
                    } else if (slOrderStatus === 'FILLED' || (slOrderStatus === 'CANCELLED_OR_FILLED' && (tpOrderStatus === 'NEW' || tpOrderStatus === null))) {
                        // Nếu SL khớp hoặc SL bị hủy (và TP không khớp/không tồn tại) -> coi là lỗ
                        isProfit = false;
                        addLog(`[DEBUG] SL order (${orderId_sl}) khớp hoặc đã bị hủy/thực hiện. Coi là LỖ.`);
                    } else {
                         // Nếu cả SL và TP đều không rõ trạng thái FILLED, hoặc không có PnL
                        addLog(`⚠️ Vị thế ${symbol} đã đóng nhưng không thể xác định kết quả chính xác (SL/TP chưa rõ, PnL chưa có). Mặc định là lỗ để an toàn.`, true);
                        isProfit = false;
                    }
                }
            } catch (pnlError) {
                addLog(`❌ Lỗi khi lấy REALIZED_PNL: ${pnlError.msg || pnlError.message}. Dựa vào trạng thái SL/TP.`, true);
                if (tpOrderStatus === 'FILLED' || (tpOrderStatus === 'CANCELLED_OR_FILLED' && (slOrderStatus === 'NEW' || slOrderStatus === null))) {
                    isProfit = true;
                } else {
                    isProfit = false;
                }
            }

            // Gọi hàm đóng và mở lệnh mới
            await closeAndOpenNewPosition(isProfit);
            return; // Dừng vòng lặp kiểm tra hiện tại để bắt đầu chu kỳ mới
        }
        
        // Vị thế vẫn đang mở, cập nhật trạng thái hiển thị PnL chưa thực hiện
        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice) {
            let pnl = 0;
            // Tính PnL chưa thực hiện (unrealized PnL)
            if (currentTradeDetails.side === 'LONG') {
                pnl = (currentPrice - currentTradeDetails.entryPrice) * quantity;
            } else { // SHORT
                pnl = (currentTradeDetails.entryPrice - currentTradeDetails.entryPrice) * quantity;
            }
            // Tính phần trăm PnL so với vốn ban đầu (đã bao gồm đòn bẩy)
            const pnlPercentage = (pnl / currentTradeDetails.initialTradeAmountUSDT) * 100;
            currentDisplayMessage = `Đang mở: ${currentTradeDetails.side} ${symbol} @ ${currentTradeDetails.entryPrice.toFixed(currentTradeDetails.pricePrecision)}. Giá hiện tại: ${currentPrice.toFixed(currentTradeDetails.pricePrecision)}. PnL: ${pnl.toFixed(2)} USDT (${pnlPercentage.toFixed(2)}%). Lỗ liên tiếp: ${consecutiveLosses}. TP: ${currentTradeDetails.initialTPPrice.toFixed(currentTradeDetails.pricePrecision)}, SL: ${currentTradeDetails.initialSLPrice.toFixed(currentTradeDetails.pricePrecision)}.`;
        }

    } catch (error) {
        addLog(`❌ Lỗi quản lý vị thế ${symbol}: ${error.msg || error.message}. Bot tạm dừng.`, true);
        currentDisplayMessage = `Lỗi theo dõi: ${error.msg || error.message}. Bot dừng.`;
        stopBotLogicInternal();
    }
}

// Hàm khởi động cập nhật hiển thị lên frontend
function startDisplayUpdateFrontend() {
    if (displayUpdateIntervalFrontend) {
        clearInterval(displayUpdateIntervalFrontend);
    }
    // Cập nhật display message mỗi 3 giây để không quá tải và đồng bộ với monitor
    displayUpdateIntervalFrontend = setInterval(() => {
        // Hàm monitorCurrentPosition đã cập nhật currentDisplayMessage
        // Không cần làm gì thêm ở đây, chỉ cần interval chạy để client có thể fetch
    }, 3000); 
}

// Hàm dừng cập nhật hiển thị
function stopDisplayUpdateFrontend() {
    if (displayUpdateIntervalFrontend) {
        clearInterval(displayUpdateIntervalFrontend);
        displayUpdateIntervalFrontend = null;
    }
    currentDisplayMessage = "Bot đã dừng hoặc không có lệnh đang chờ đóng.";
}


// --- HÀM KHỞI ĐỘNG/DỪNG LOGIC BOT (nội bộ, không phải lệnh PM2) ---

async function startBotLogicInternal() {
    if (botRunning) {
        addLog('Bot đang chạy.', true);
        return 'Bot đang chạy.';
    }

    addLog('--- Khởi động Bot ---', true);
    addLog('>>> Kiểm tra kết nối API Binance Futures...', true);
    currentDisplayMessage = "Đang khởi động bot...";

    try {
        await syncServerTime();

        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key OK! USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`, true);

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Lỗi tải exchangeInfo. Bot dừng.', true);
            botRunning = false;
            currentDisplayMessage = "Lỗi khởi động: Không thể tải exchangeInfo.";
            return 'Không thể tải exchangeInfo.';
        }

        botRunning = true;
        botStartTime = new Date();
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`, true);
        currentDisplayMessage = "Bot đã khởi động thành công. Đang chờ lệnh đầu tiên...";

        // Nếu bot được khởi động lại và có lệnh cũ (currentTradeDetails không null), tiếp tục theo dõi
        // Ngược lại, bắt đầu lệnh đầu tiên
        if (!currentTradeDetails) {
            addLog(`>>> Đang bắt đầu lệnh đầu tiên (${currentTradeDirection} ${SYMBOL}) với ${INITIAL_TRADE_AMOUNT_USDT} USDT...`, true);
            await openNewPosition(SYMBOL, INITIAL_TRADE_AMOUNT_USDT, currentTradeDirection);
        } else {
            addLog(`>>> Phát hiện lệnh cũ đang hoạt động. Tiếp tục theo dõi...`, true);
        }
        
        // Bắt đầu vòng lặp kiểm tra và quản lý vị thế
        if (!positionMonitorInterval) { // Đảm bảo chỉ tạo 1 interval
            positionMonitorInterval = setInterval(async () => {
                if (botRunning) {
                    await monitorCurrentPosition();
                } else {
                    clearInterval(positionMonitorInterval);
                    positionMonitorInterval = null;
                }
            }, 5000); // Kiểm tra mỗi 5 giây
        }
        
        startDisplayUpdateFrontend();

        return 'Bot khởi động thành công.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        addLog('❌ [Lỗi khởi động bot] ' + errorMsg, true);
        addLog('   -> Bot dừng. Kiểm tra và khởi động lại.', true);
        currentDisplayMessage = `Lỗi khởi động: ${errorMsg}. Bot dừng.`;
        stopBotLogicInternal();
        return `Lỗi khởi động bot: ${errorMsg}`;
    }
}

function stopBotLogicInternal() {
    if (!botRunning) {
        addLog('Bot không chạy.', true);
        return 'Bot không chạy.';
    }
    botRunning = false;
    if (positionMonitorInterval) {
        clearInterval(positionMonitorInterval);
        positionMonitorInterval = null;
    }
    clearTimeout(nextScheduledTimeout); // Clear bất kỳ timeout nào đang chờ (nếu có)
    stopDisplayUpdateFrontend();
    addLog('--- Bot đã dừng ---', true);
    botStartTime = null;
    currentDisplayMessage = "Bot đã dừng.";
    
    // Hủy tất cả các lệnh mở còn sót lại khi bot dừng
    cancelOpenOrdersForSymbol(SYMBOL)
        .then(() => addLog('✅ Đã hủy tất cả lệnh mở khi dừng bot.', true))
        .catch(err => addLog(`❌ Lỗi hủy lệnh khi dừng bot: ${err.message}`, true));

    return 'Bot đã dừng.';
}

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();

app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' directory
// Nếu bạn không muốn tạo thư mục public, có thể dùng:
// app.get('/', (req, res) => {
//     res.sendFile(path.join(__dirname, 'index.html'));
// });


app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Lỗi đọc log file:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Không tìm thấy log file: ${BOT_LOG_FILE}. Đảm bảo PM2 đã tạo log.`);
            }
            return res.status(500).send('Lỗi đọc log file');
        }
        // Xóa các mã màu ANSI để log hiển thị sạch trên web
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
                if (error) {
                    addLog(`❌ Lỗi chạy PM2 jlist: ${stderr || error.message}`);
                    reject(stderr || error.message);
                }
                resolve(stdout);
            });
        });
        const processes = JSON.parse(pm2List);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME);

        let statusResponse = {
            pm2_status: 'stopped',
            pm2_message: `Bot: Không tìm thấy trong PM2 (Tên: ${THIS_BOT_PM2_NAME}). Đảm bảo bot đã được khởi chạy bằng PM2.`,
            bot_logic_status: botRunning ? 'running' : 'stopped',
            bot_start_time: botStartTime ? formatTimeUTC7(botStartTime) : null,
            uptime_minutes: botStartTime ? Math.floor((Date.now() - botStartTime.getTime()) / (1000 * 60)) : 0,
            current_trade_details: currentTradeDetails,
            consecutive_losses: consecutiveLosses,
            current_trade_amount_usdt: currentTradeAmountUSDT,
            current_trade_direction: currentTradeDirection,
            display_message: currentDisplayMessage // Message cho frontend
        };

        if (botProcess) {
            statusResponse.pm2_status = botProcess.pm2_env.status;
            statusResponse.pm2_message = `PM2: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
        } else {
             // Nếu không tìm thấy trong PM2, giả định bot logic cũng đang dừng
             statusResponse.bot_logic_status = 'stopped';
        }

        res.json(statusResponse);
    } catch (error) {
        addLog(`❌ Lỗi lấy trạng thái PM2: ${error.message}`);
        res.status(500).json({ error: `Lỗi lấy trạng thái PM2: ${error.message}`, pm2_status: 'error' });
    }
});

app.get('/api/display_message', (req, res) => {
    res.send(currentDisplayMessage);
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
    addLog(`Web server trên cổng ${WEB_SERVER_PORT}`, true);
    addLog(`Truy cập: http://localhost:${WEB_SERVER_PORT}`, true);
});

// --- KHÔNG TỰ ĐỘNG KHỞI ĐỘNG BOT LOGIC KHI CHẠY FILE ---
// Để bot chạy, bạn cần gọi API '/start_bot_logic' từ giao diện web hoặc qua PM2.
// Điều này giúp bạn kiểm soát hoàn toàn việc khởi động bot logic.
// Nếu muốn bot tự động chạy khi khởi động script, bỏ comment dòng dưới đây:
// startBotLogicInternal();
