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
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // THAY THAY THẾ BẰNG SECRET KEY THẬT CỦA BẠN

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

// Biến để lưu trữ tổng PnL từ lúc bot chạy
let totalRealizedPnl = 0;

// --- CẤU HÌNH BOT CÁC THAM SỐ GIAO DỊCH ---
const SYMBOL = 'YFIUSDT'; // Đồng coin áp dụng chiến lược này (hoặc BTCUSDT)

// THAY ĐỔI CÁCH CẤU HÌNH VỐN BAN ĐẦU:
// Thay vì cố định số USDT, giờ đây là % số dư USDT khả dụng
const INITIAL_TRADE_AMOUNT_PERCENTAGE = 15; // 1% số dư USDT khả dụng cho lệnh đầu tiên
// Lưu ý: Giá trị này sẽ được tính toán thành USDT thực tế khi bot khởi động.
let INITIAL_TRADE_AMOUNT_USDT_ACTUAL = 0; // Số vốn USDT thực tế được tính toán

// Cấu hình Stop Loss và Take Profit
// TP mặc định cho tất cả lệnh = 125% vốn của lệnh đó
const TAKE_PROFIT_PERCENTAGE = 0.15; 
// SL mặc định cho tất cả lệnh = 80% vốn của lệnh đó
const STOP_LOSS_PERCENTAGE = 0.11; 

// XÓA BIẾN LEVERAGE CỐ ĐỊNH, SẼ LẤY TỪ EXCHANGEINFO
// const LEVERAGE = 75; 

// Vòng lặp nếu lỗ 6 lần liên tiếp => trở lại mức ban đầu
const MAX_CONSECUTIVE_LOSSES = 6;

// --- BIẾN THEO DÕI TRẠNG THÁI CHIẾN LƯỢC ---
let currentTradeAmountUSDT = 0; // Vốn cho lệnh hiện tại, sẽ được gán từ INITIAL_TRADE_AMOUNT_USDT_ACTUAL
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

// Hàm để hiển thị log tóm tắt cho PM2 (theo yêu cầu)
function displaySummaryLogForPM2() {
    if (!botRunning) {
        return; // Không hiển thị nếu bot không chạy
    }
    const uptimeMs = botStartTime ? (Date.now() - botStartTime.getTime()) : 0;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const uptimeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    let tradeStatus = "Chưa có lệnh";
    if (currentTradeDetails) {
        tradeStatus = `${currentTradeDetails.side} ${currentTradeDetails.symbol}`;
    }

    // Định dạng log cho PM2 theo yêu cầu
    console.log(`${SYMBOL}: Tổng PnL: ${totalRealizedPnl.toFixed(2)} USDT`);
    console.log(`Thời gian chạy: ${uptimeString}`);
    console.log(`Trạng thái: ${currentDisplayMessage}`); // Hiển thị chi tiết trạng thái lệnh
    console.log(`Lỗ liên tiếp: ${consecutiveLosses}`);
    console.log(`-----`); // Dấu phân cách cho dễ nhìn
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
    const recvWindow = 5000; // Có thể tăng lên 10000 hoặc 15000 nếu gặp lỗi timestamp/network
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

            let maxLeverage = null;
            if (s.leverageBrackets && s.leverageBrackets.length > 0) {
                // Lấy maxLeverage từ bracket đầu tiên, hoặc tìm maxLeverage cao nhất nếu cần
                maxLeverage = parseFloat(s.leverageBrackets[0].maxLeverage);
                // Để lấy đòn bẩy cao nhất trong tất cả các bracket (phòng trường hợp đòn bẩy giảm theo khối lượng):
                // maxLeverage = Math.max(...s.leverageBrackets.map(b => parseFloat(b.maxLeverage)));
            }

            exchangeInfoCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0.001), 
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001,
                maxLeverage: maxLeverage // LƯU MAX LEVERAGE VÀO CACHE CHO TỪNG SYMBOL
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
        addLog(`✅ Đã đặt đòn bòn bẩy ${leverage}x cho ${symbol}.`);
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
async function closeAndOpenNewPosition(isProfit, currentPosition = null) { // Thêm currentPosition để tái sử dụng thông tin nếu có
    addLog(`\n--- Bắt đầu chu kỳ mới: ${isProfit ? 'LÃI' : 'LỖ'} ---`, true);
    currentDisplayMessage = `Lệnh trước: ${isProfit ? 'LÃI' : 'LỖ'}. Đang chuẩn bị lệnh mới...`;

    const symbol = SYMBOL;
    
    // --- 1. Hủy tất cả các lệnh mở hiện tại (bao gồm cả TP/SL còn sót lại) ---
    await cancelOpenOrdersForSymbol(symbol);
    
    // --- 2. Kiểm tra và đóng vị thế hiện có trên sàn (nếu có vị thế sót) ---
    // Điều này quan trọng nếu bot bị dừng đột ngột và có vị thế mở mà chưa được đóng bởi TP/SL
    // Hoặc trong trường hợp TP/SL bị mất nhưng vị thế vẫn còn, ta buộc phải đóng nó.
    let actualOpenPosition = currentPosition;
    if (!actualOpenPosition) { // Chỉ gọi API nếu chưa có thông tin vị thế truyền vào
        try {
            const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
            actualOpenPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
        } catch (error) {
            addLog(`❌ Lỗi khi lấy vị thế để đóng: ${error.code} - ${error.msg || error.message}`);
            // Tiếp tục, nhưng ghi nhận lỗi
        }
    }
    

    if (actualOpenPosition) {
        const positionAmt = parseFloat(actualOpenPosition.positionAmt);
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
            
            try {
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
            } catch (closeError) {
                // Lỗi -2011: No position found on this symbol. Có thể vị thế đã đóng ngay trước khi bot gửi lệnh.
                if (closeError.code === -2011 || closeError.msg.includes('No position found')) {
                    addLog(`⚠️ Đã cố gắng đóng vị thế nhưng không còn vị thế mở cho ${symbol}.`, true);
                } else {
                    addLog(`❌ Lỗi khi cố gắng đóng vị thế hiện có trên sàn: ${closeError.code} - ${closeError.msg || closeError.message}`);
                }
            }
        }
    } else {
        addLog(`>>> Không có vị thế mở nào của ${symbol} trên sàn.`, true);
    }

    // --- CẬP NHẬT TỔNG PNL ---
    try {
        const pnlResult = await callSignedAPI('/fapi/v2/income', 'GET', {
            symbol: symbol,
            incomeType: 'REALIZED_PNL',
            startTime: new Date(Date.now() - (5 * 60 * 1000)).getTime(), // Lấy PnL trong 5 phút gần nhất
            limit: 1 // Chỉ lấy giao dịch gần nhất
        });
        if (pnlResult && pnlResult.length > 0) {
            const latestPnlEntry = pnlResult.sort((a,b) => b.time - a.time)[0]; // Đảm bảo lấy cái mới nhất
            const realizedPnlThisTrade = parseFloat(latestPnlEntry.income);
            totalRealizedPnl += realizedPnlThisTrade;
            addLog(`[DEBUG] PnL thực hiện của lệnh vừa rồi: ${realizedPnlThisTrade.toFixed(2)} USDT. Tổng PnL: ${totalRealizedPnl.toFixed(2)} USDT.`);
            isProfit = realizedPnlThisTrade > 0; // Cập nhật lại isProfit dựa trên PnL thực tế
        } else {
            addLog(`⚠️ Không tìm thấy REALIZED_PNL cho lệnh vừa đóng. Không cập nhật tổng PnL.`);
        }
    } catch (pnlError) {
        addLog(`❌ Lỗi khi lấy REALIZED_PNL để cập nhật tổng PnL: ${pnlError.msg || pnlError.message}`);
    }


    // --- 3. Cập nhật trạng thái và chuẩn bị cho lệnh mới ---
    if (isProfit) {
        consecutiveLosses = 0; // Reset số lệnh lỗ liên tiếp
        // Dùng INITIAL_TRADE_AMOUNT_USDT_ACTUAL để đảm bảo vốn ban đầu luôn là 1% của số dư hiện tại
        currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT_ACTUAL; 
        // currentTradeDirection KHÔNG ĐỔI nếu lãi (theo yêu cầu "mở 1 lệnh cùng chiều vị thế hiện tại").
        // Nếu lệnh ban đầu là Long, và nó lãi, lệnh tiếp theo là Long.
        // Nếu lệnh Long ban đầu lỗ, thành Short. Nếu Short này lãi, lệnh tiếp theo là Short.
        
        addLog(`✅ Lệnh trước đã lãi. Vốn mới: ${currentTradeAmountUSdt.toFixed(2)} USDT. Chiều: ${currentTradeDirection}.`, true);
    } else { // Lỗ
        consecutiveLosses++;
        if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
            addLog(`⚠️ Đã lỗ ${consecutiveLosses} lần liên tiếp. Reset về vốn ban đầu và chiều LONG.`, true);
            // Dùng INITIAL_TRADE_AMOUNT_USDT_ACTUAL để đảm bảo vốn ban đầu luôn là 1% của số dư hiện tại
            currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT_ACTUAL;
            currentTradeDirection = 'LONG'; // Reset về Long
            consecutiveLosses = 0; // Reset lại số lệnh lỗ liên tiếp
        } else {
            currentTradeAmountUSDT *= 2; // Gấp đôi vốn
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
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            addLog(`❌ Lỗi lấy chi tiết symbol ${symbol}. Không mở lệnh.`, true);
            throw new Error('Không thể lấy chi tiết symbol.');
        }

        // Lấy đòn bẩy tối đa từ exchangeInfo, fallback về 20 nếu không tìm thấy
        const actualLeverage = symbolDetails.maxLeverage || 20; 
        if (!actualLeverage) {
            addLog(`❌ Không tìm thấy đòn bẩy tối đa cho ${symbol}. Không mở lệnh.`, true);
            throw new Error('Không thể xác định đòn bẩy tối đa.');
        }
        await setLeverage(symbol, actualLeverage); // Đặt đòn bẩy thực tế đã lấy được
        addLog(`[DEBUG] Đòn bẩy đã đặt cho ${symbol}: ${actualLeverage}x`);


        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Lỗi lấy giá hiện tại cho ${symbol}. Không mở lệnh.`, true);
            throw new Error('Không thể lấy giá hiện tại.');
        }
        addLog(`[DEBUG] Giá ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // Tính toán số lượng (quantity) dựa trên vốn, đòn bẩy và giá hiện tại
        let quantity = (tradeAmountUSDT * actualLeverage) / currentPrice;
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

        // Tính toán SL/TP dựa trên phần trăm vốn và đòn bẩy (actualLeverage)
        let slPrice, tpPrice;
        
        if (side === 'LONG') {
            // SL: Giá giảm 80% vốn / đòn bẩy. TP: Giá tăng 125% vốn / đòn bẩy
            slPrice = entryPrice * (1 - STOP_LOSS_PERCENTAGE / actualLeverage); 
            tpPrice = entryPrice * (1 + TAKE_PROFIT_PERCENTAGE / actualLeverage); 
        } else { // SHORT
            // SL: Giá tăng 80% vốn / đòn bẩy. TP: Giá giảm 125% vốn / đòn bẩy
            slPrice = entryPrice * (1 + STOP_LOSS_PERCENTAGE / actualLeverage);
            tpPrice = entryPrice * (1 - TAKE_PROFIT_PERCENTAGE / actualLeverage);
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
        // Đối với Short: SL nên được làm tròn lên (để chắc chắn giá chạm stopPrice nếu giá tăng), TP làm tròn lên (để chắc chắn giá chạm stopPrice nếu giá giảm)
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
                closePosition: 'true', // Chỉ định lệnh này chỉ dùng để đóng vị thế
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
                closePosition: 'true', // Chỉ định lệnh này chỉ dùng để đóng vị thế
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
        displaySummaryLogForPM2(); // Vẫn hiển thị log tóm tắt
        return;
    }

    const { symbol, quantity, entryPrice, side, initialTradeAmountUSDT, initialTPPrice, initialSLPrice, pricePrecision, quantityPrecision, orderId_sl, orderId_tp } = currentTradeDetails;
    // Cập nhật trạng thái hiển thị
    let pnl = 0; // PnL chưa thực hiện
    let pnlPercentage = 0; // Phần trăm PnL chưa thực hiện

    try {
        // --- BƯỚC 1: Lấy tất cả lệnh mở trên sàn để kiểm tra trạng thái SL/TP ---
        const openOrdersOnBinance = await callSignedAPI('/fapi/v1/openOrders', 'GET', { symbol: symbol });
        const slOrderStillOpen = openOrdersOnBinance.find(o => o.orderId == orderId_sl);
        const tpOrderStillOpen = openOrdersOnBinance.find(o => o.orderId == orderId_tp);

        let slOrderStatus = slOrderStillOpen ? slOrderStillOpen.status : 'NOT_EXIST';
        let tpOrderStatus = tpOrderStillOpen ? tpOrderStillOpen.status : 'NOT_EXIST';

        // addLog(`[DEBUG] SL status: ${slOrderStatus}, TP status: ${tpOrderStatus}`); // Bỏ comment để debug chi tiết hơn

        // --- BƯỚC 2: Kiểm tra vị thế thực tế trên sàn ---
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        // Lấy giá hiện tại để tính PnL và kiểm tra kích hoạt TP/SL
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không thể theo dõi vị thế.`, true);
            displaySummaryLogForPM2(); // Vẫn hiển thị log tóm tắt
            return; // Dừng nếu không có giá để tránh lỗi
        }

        // Tính PnL chưa thực hiện (unrealized PnL) cho hiển thị
        if (side === 'LONG') {
            pnl = (currentPrice - entryPrice) * quantity;
        } else { // SHORT
            pnl = (entryPrice - currentPrice) * quantity;
        }
        pnlPercentage = (pnl / initialTradeAmountUSDT) * 100;
        currentDisplayMessage = `Đang mở: ${side} ${symbol} @ ${entryPrice.toFixed(pricePrecision)}. Giá hiện tại: ${currentPrice.toFixed(pricePrecision)}. PnL: ${pnl.toFixed(2)} USDT (${pnlPercentage.toFixed(2)}%). Lỗ liên tiếp: ${consecutiveLosses}. TP: ${initialTPPrice.toFixed(pricePrecision)}, SL: ${initialSLPrice.toFixed(pricePrecision)}.`;

        displaySummaryLogForPM2(); // Hiển thị log tóm tắt cho PM2

        // --- BƯỚC 3: Xử lý dựa trên trạng thái vị thế và lệnh TP/SL ---

        // Trường hợp 1: Vị thế đã đóng trên sàn (hoặc số lượng positionAmt rất nhỏ không đáng kể)
        if (!openPositionOnBinance) {
            addLog(`>>> Vị thế ${symbol} đã đóng trên sàn. Đang xác định kết quả...`, true);
            await cancelOpenOrdersForSymbol(symbol); // Hủy bất kỳ lệnh chờ nào còn sót lại
            
            // Hàm closeAndOpenNewPosition sẽ tự động xác định PnL thực hiện và cập nhật totalRealizedPnl
            await closeAndOpenNewPosition(false); // isProfit ban đầu chỉ là placeholder, sẽ được xác định lại bên trong
            return; // Kết thúc chu kỳ monitor
        }

        // Trường hợp 2: Vị thế vẫn mở
        // Check nếu TP hoặc SL gốc không còn trên sàn. (hoặc orderId_sl/orderId_tp là null do lỗi đặt lệnh ban đầu)
        if (!slOrderStillOpen || !tpOrderStillOpen || orderId_sl === null || orderId_tp === null) {
            addLog(`⚠️ Vị thế ${symbol} đang mở nhưng TP/SL đã mất hoặc không được đặt. Đang theo dõi giá để đóng vị thế.`, true);
            currentDisplayMessage = `⚠️ TP/SL bị mất! Đang theo dõi giá để đóng vị thế ${side} ${symbol} @ ${currentPrice.toFixed(pricePrecision)}. PnL: ${pnl.toFixed(2)} USDT.`;

            let actionTaken = false;
            let finalIsProfit = false;

            // Kiểm tra xem giá đã chạm SL (dù lệnh SL đã mất)
            if (side === 'LONG' && currentPrice <= initialSLPrice) {
                addLog(`🔥 Giá chạm SL (${initialSLPrice.toFixed(pricePrecision)}) cho LONG position. Đang đóng vị thế!`, true);
                finalIsProfit = false;
                actionTaken = true;
            } else if (side === 'SHORT' && currentPrice >= initialSLPrice) {
                addLog(`🔥 Giá chạm SL (${initialSLPrice.toFixed(pricePrecision)}) cho SHORT position. Đang đóng vị thế!`, true);
                finalIsProfit = false;
                actionTaken = true;
            } 
            // Kiểm tra xem giá đã chạm TP (dù lệnh TP đã mất)
            else if (side === 'LONG' && currentPrice >= initialTPPrice) {
                addLog(`✅ Giá chạm TP (${initialTPPrice.toFixed(pricePrecision)}) cho LONG position. Đang đóng vị thế!`, true);
                finalIsProfit = true;
                actionTaken = true;
            } else if (side === 'SHORT' && currentPrice <= initialTPPrice) {
                addLog(`✅ Giá chạm TP (${initialTPPrice.toFixed(pricePrecision)}) cho SHORT position. Đang đóng vị thế!`, true);
                finalIsProfit = true;
                actionTaken = true;
            }

            if (actionTaken) {
                // Hủy các lệnh còn lại (nếu có) trước khi đóng
                await cancelOpenOrdersForSymbol(symbol); 
                // Gọi hàm đóng vị thế và mở lệnh mới (lưu ý: closeAndOpenNewPosition sẽ tự kiểm tra và đóng vị thế nếu còn)
                await closeAndOpenNewPosition(finalIsProfit, openPositionOnBinance);
                return; // Kết thúc chu kỳ monitor này để bắt đầu chu kỳ mới
            }
        }
        
        // Nếu không có gì đặc biệt xảy ra (vị thế đang mở, TP/SL vẫn hoạt động), chỉ cập nhật hiển thị PnL
        // Logic hiển thị đã được đưa lên trên để luôn cập nhật trạng thái
        
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
        const usdtBalance = parseFloat(account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0);
        addLog(`✅ API Key OK! USDT khả dụng: ${usdtBalance.toFixed(2)}`, true);

        // --- CẬP NHẬT: Tính toán INITIAL_TRADE_AMOUNT_USDT_ACTUAL dựa trên % số dư ---
        INITIAL_TRADE_AMOUNT_USDT_ACTUAL = usdtBalance * (INITIAL_TRADE_AMOUNT_PERCENTAGE / 100);
        addLog(`>>> Vốn ban đầu cho lệnh đầu tiên (dựa trên ${INITIAL_TRADE_AMOUNT_PERCENTAGE}% số dư): ${INITIAL_TRADE_AMOUNT_USDT_ACTUAL.toFixed(2)} USDT`, true);
        // Cập nhật currentTradeAmountUSDT ban đầu
        currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT_ACTUAL;


        await getExchangeInfo();
        if (!exchangeInfoCache) {
            addLog('❌ Lỗi tải exchangeInfo. Bot dừng.', true);
            botRunning = false;
            currentDisplayMessage = "Lỗi khởi động: Không thể tải exchangeInfo.";
            return 'Không thể tải exchangeInfo.';
        }

        // --- CẬP NHẬT: Kiểm tra số dư có đủ để mở lệnh tối thiểu của sàn không ---
        const symbolDetails = await getSymbolDetails(SYMBOL);
        if (!symbolDetails) {
            addLog(`❌ Lỗi lấy chi tiết symbol ${SYMBOL}. Không thể kiểm tra điều kiện đủ vốn. Bot dừng.`, true);
            currentDisplayMessage = `Lỗi khởi động: Không thể lấy chi tiết symbol ${SYMBOL}.`;
            stopBotLogicInternal();
            return 'Không thể lấy chi tiết symbol.';
        }

        const currentPrice = await getCurrentPrice(SYMBOL);
        if (!currentPrice) {
            addLog(`❌ Lỗi lấy giá hiện tại cho ${SYMBOL}. Không thể kiểm tra điều kiện đủ vốn. Bot dừng.`, true);
            currentDisplayMessage = `Lỗi khởi động: Không thể lấy giá hiện tại cho ${SYMBOL}.`;
            stopBotLogicInternal();
            return 'Không thể lấy giá hiện tại.';
        }

        const minNotionalNeeded = symbolDetails.minNotional; // Ví dụ: 5.0 USDT là giá trị tối thiểu cho lệnh
        const minQtyNeeded = symbolDetails.minQty; // Số lượng tối thiểu
        
        // DÙNG maxLeverage TỪ symbolDetails ĐỂ TÍNH TOÁN NOTIONAL HIỆN TẠI
        const currentInvestmentNotional = INITIAL_TRADE_AMOUNT_USDT_ACTUAL * (symbolDetails.maxLeverage || 20); // Dùng maxLeverage hoặc fallback về 20

        if (currentInvestmentNotional < minNotionalNeeded) {
            addLog(`❌ Số vốn ${INITIAL_TRADE_AMOUNT_USDT_ACTUAL.toFixed(2)} USDT (${INITIAL_TRADE_AMOUNT_PERCENTAGE}% số dư) không đủ để đạt Notional tối thiểu của sàn (${minNotionalNeeded} USDT) với đòn bẩy tối đa. Bot dừng.`, true);
            currentDisplayMessage = `Lỗi khởi động: Vốn không đủ. Cần ít nhất ${minNotionalNeeded.toFixed(2)} USDT Notional (vốn * đòn bẩy).`;
            stopBotLogicInternal();
            return `Vốn không đủ để mở lệnh tối thiểu.`;
        }
        
        addLog(`✅ Số vốn ban đầu đủ điều kiện Notional tối thiểu của sàn (${minNotionalNeeded.toFixed(2)} USDT).`, true);


        botRunning = true;
        botStartTime = new Date();
        totalRealizedPnl = 0; // Reset tổng PnL khi khởi động bot
        addLog(`--- Bot đã chạy lúc ${formatTimeUTC7(botStartTime)} ---`, true);
        currentDisplayMessage = "Bot đã khởi động thành công. Đang chờ lệnh đầu tiên...";

        // Nếu bot được khởi động lại và có lệnh cũ (currentTradeDetails không null), tiếp tục theo dõi
        // Ngược lại, bắt đầu lệnh đầu tiên
        if (!currentTradeDetails) {
            addLog(`>>> Đang bắt đầu lệnh đầu tiên (${currentTradeDirection} ${SYMBOL}) với vốn ${currentTradeAmountUSDT.toFixed(2)} USDT...`, true);
            await openNewPosition(SYMBOL, currentTradeAmountUSDT, currentTradeDirection);
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
    currentTradeDetails = null; // Reset trade details khi dừng bot hoàn toàn
    consecutiveLosses = 0; // Reset số lệnh thua
    currentTradeAmountUSDT = INITIAL_TRADE_AMOUNT_USDT_ACTUAL; // Reset vốn về giá trị ban đầu (từ % tài khoản)
    currentTradeDirection = 'LONG'; // Reset chiều
    totalRealizedPnl = 0; // Reset tổng PnL khi dừng bot

    // Hủy tất cả các lệnh mở còn sót lại khi bot dừng
    cancelOpenOrdersForSymbol(SYMBOL)
        .then(() => addLog('✅ Đã hủy tất cả lệnh mở khi dừng bot.', true))
        .catch(err => addLog(`❌ Lỗi hủy lệnh khi dừng bot: ${err.message}`, true));

    return 'Bot đã dừng.';
}

// --- KHỞI TẠO SERVER WEB VÀ CÁC API ENDPOINT ---
const app = express();

// Phục vụ file index.html từ thư mục hiện tại (binance)
app.use(express.static(__dirname));

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
            display_message: currentDisplayMessage, // Message cho frontend
            total_realized_pnl: totalRealizedPnl // Thêm tổng PnL vào status
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
