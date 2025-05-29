import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http'; // Import createServer

// Để thay thế __dirname trong ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === API KEY & SECRET ===
// !!! QUAN TRỌNG: DÁN API Key và Secret Key THẬT của bạn vào đây. !!!
// Đảm bảo không có khoảng trắng thừa khi copy/paste.
const API_KEY = 'DÁN_API_KEY_CỦA_BẠN_VÀO_ĐÂY'.trim();
const SECRET_KEY = 'DÁN_SECRET_KEY_CỦA_BẠN_VÀO_ĐÂY'.trim();

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Giữ nguyên để tương thích

// Biến cache cho exchangeInfo
let exchangeInfoCache = null;

// Biến cờ để tránh việc gửi nhiều lệnh đóng cùng cùng lúc
let isClosingPosition = false;

let botRunning = false; // Biến cờ kiểm soát trạng thái chạy của bot
let botStartTime = null; // Thời điểm bot được khởi động

// --- Cấu hình Server Web ---
const PORT = 3000;
const app = express();
const server = createServer(app); // Tạo HTTP server cho cả Express và WS
const wss = new WebSocketServer({ server }); // WebSocket Server chạy trên cùng cổng

// *** ĐIỀU CHỈNH QUAN TRỌNG Ở ĐÂY: Phục vụ file tĩnh từ chính thư mục của bot.js
app.use(express.static(__dirname));

// Định nghĩa một WebSocket client để gửi log
let wsClient = null;

wss.on('connection', ws => {
    wsClient = ws;
    addLog('Websocket client connected.', true); // Gửi log đặc biệt cho kết nối WS
    // Gửi trạng thái hiện tại của bot cho client mới kết nối
    if (botRunning) {
        wsClient.send(JSON.stringify({ type: 'status', message: `Bot Status: Bot is running.` }));
    } else {
        wsClient.send(JSON.stringify({ type: 'status', message: `Bot Status: Bot is stopped.` }));
    }
    // Cập nhật vị thế hiện tại nếu có
    if (currentOpenPosition) {
        wsClient.send(JSON.stringify({ type: 'status', message: `Bot Status: Current position: ${currentOpenPosition.symbol}` }));
    } else {
        wsClient.send(JSON.stringify({ type: 'status', message: `Bot Status: Current position: None` }));
    }
});

// Hàm addLog để ghi nhật ký, giờ hiển thị theo UTC+7 (giờ VN)
// Thêm tham số `isInternalLog` để không gửi log qua WebSocket nếu đó là log nội bộ từ WS
function addLog(message, isInternalLog = false) {
    const now = new Date();
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
    const time = formatter.format(now);
    const logEntry = `[${time}] ${message}\n----------------------------------------------------`;
    console.log(logEntry); // Luôn in ra console

    // Gửi log qua WebSocket nếu có client kết nối và không phải log nội bộ
    if (wsClient && wsClient.readyState === wsClient.OPEN && !isInternalLog) {
        wsClient.send(JSON.stringify({ type: 'log', message: logEntry }));
    }
}


// Endpoint API để khởi động bot
app.get('/start', (req, res) => {
    if (!botRunning) {
        addLog('Nhận lệnh START từ giao diện web.', true); // true để không log ra WS
        startBot();
        res.send('Bot đang khởi động...');
    } else {
        res.send('Bot đã và đang chạy rồi.');
    }
});

// Endpoint API để dừng bot
app.get('/stop', (req, res) => {
    if (botRunning) {
        addLog('Nhận lệnh STOP từ giao diện web.', true); // true để không log ra WS
        stopBot();
        res.send('Bot đang dừng...');
    } else {
        res.send('Bot hiện không chạy.');
    }
});

// Khởi chạy server HTTP/WebSocket
// === ĐIỀU CHỈNH QUAN TRỌNG: Đảm bảo server lắng nghe cổng ===
server.listen(PORT, () => {
    addLog(`Server bot đang lắng nghe tại http://localhost:${PORT} (truy cập từ trình duyệt: http://34.142.248.96:${PORT}/bot_binance.html)`, true);
    addLog('Đợi lệnh START từ giao diện web hoặc console.', true);
});


// Sửa lỗi: Hàm delay giờ nhận một callback để setTimeout hoạt động đúng
// Đã sửa lỗi TypeError [ERR_INVALID_ARG_TYPE]
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


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
    const timestamp = Date.now();

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
    addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms.`);
  } catch (error) {
    addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}.`);
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

  addLog('>>> Đang lấy exchangeInfo từ Binance...');
  try {
    const data = await callPublicAPI('/fapi/v1/exchangeInfo');
    addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`);

    exchangeInfoCache = {};
    data.symbols.forEach(s => {
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
    addLog('>>> Đã tải thông tin sàn và cache thành công.');
    return exchangeInfoCache;
  } catch (error) {
    addLog('❌ Lỗi khi lấy exchangeInfo: ' + (error.msg || error.message));
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

// === Cấu hình Bot ===
const MIN_USDT_BALANCE_TO_OPEN = 0.1; // Số dư USDT tối thiểu để mở lệnh (0.1 USDT)
const CAPITAL_PERCENTAGE_PER_TRADE = 0.5; // Phần trăm vốn sử dụng cho mỗi lệnh (50% tài khoản)

// Cấu hình TP/SL theo yêu cầu mới
const STOP_LOSS_PERCENTAGE = 0.70; // SL cố định 70% của vốn đầu tư ban đầu

// Bảng ánh xạ maxLeverage với Take Profit percentage
const TAKE_PROFIT_PERCENTAGES = {
    20: 0.20,
    25: 0.25,
    50: 0.50,
    75: 0.75,
    100: 1.00,
    125: 1.25,
};

const MIN_FUNDING_RATE_THRESHOLD = -0.0001; // Ngưỡng funding rate âm tối thiểu để xem xét (ví dụ: -0.01% = -0.0001)
const MAX_POSITION_LIFETIME_SECONDS = 300; // Thời gian tối đa giữ một vị thế (tính bằng giây), ví dụ: 300 giây = 5 phút

// Cấu hình thời gian chạy bot theo giờ UTC MỚI
const SCAN_MINUTE_UTC = 58; // Phút thứ 58 để quét và chọn đồng coin
const OPEN_ORDER_MINUTE_UTC = 0; // Giờ XX:00:00:100 để mở lệnh (được tính toán cụ thể trong code)
const TARGET_SECOND_UTC = 0;  // Giây thứ 0
const TARGET_MILLISECOND_UTC = 100; // mili giây thứ 100

// Các giờ funding rate của Binance Futures (UTC)
const FUNDING_HOURS_UTC = [0, 8, 16]; 

let currentOpenPosition = null; // Biến toàn cục để theo dõi vị thế đang mở
let positionCheckInterval = null; // Biến để lưu trữ setInterval cho việc kiểm tra vị thế
let nextScheduledTimeout = null; // Biến để lưu trữ setTimeout cho lần chạy tiếp theo

// --- Hàm chính để đóng lệnh Short ---
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    addLog(`\n>>> Đang cố gắng đóng lệnh SHORT cho ${symbol} với khối lượng ${quantityToClose}.`);
    try {
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo) {
            addLog(`❌ Không thể lấy thông tin symbol cho ${symbol} để đóng lệnh.`);
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        const adjustedQuantity = parseFloat(quantityToClose.toFixed(quantityPrecision));

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> Không có vị thế SHORT để đóng cho ${symbol} hoặc đã đóng trên sàn.`);
            currentOpenPosition = null; 
            clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
            positionCheckInterval = null;
            return;
        }

        addLog(`[DEBUG] Gửi lệnh đóng SHORT: symbol=${symbol}, side=BUY, type=MARKET, quantity=${adjustedQuantity}, reduceOnly=true`);
        
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY', // Để đóng lệnh SHORT, cần lệnh BUY
            type: 'MARKET',
            quantity: adjustedQuantity,
            reduceOnly: 'true' 
        });

        addLog(`✅ Đã đóng vị thế SHORT cho ${symbol}. Lý do: ${reason}.`);
        currentOpenPosition = null; 
        clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
        positionCheckInterval = null;

        // Lên lịch cho lần quét tiếp theo sau khi đóng lệnh
        if(botRunning) { // Chỉ lên lịch nếu bot đang chạy
            scheduleNextMainCycle();
        }

    } catch (error) {
        addLog(`❌ Lỗi khi đóng lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
    }
}

// --- Hàm chính để mở lệnh Short ---
async function openShortPosition(symbol, fundingRate, usdtBalance) {
    addLog(`\n>>> Đang cố gắng mở lệnh SHORT cho ${symbol} với Funding Rate: ${fundingRate}`);
    try {
        // 1. Lấy thông tin symbol và đòn bẩy
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo || typeof symbolInfo.maxLeverage !== 'number' || symbolInfo.maxLeverage <= 1) {
            addLog(`❌ Không thể lấy thông tin đòn bẩy hợp lệ cho ${symbol}. Không mở lệnh.`);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ
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
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ
            return;
        }
        addLog(`[DEBUG] Giá hiện tại của ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // 4. Tính toán khối lượng lệnh
        const capitalToUse = usdtBalance * CAPITAL_PERCENTAGE_PER_TRADE; // Vốn USDT đầu tư
        let quantity = (capitalToUse * maxLeverage) / currentPrice; // Khối lượng theo giá trị đòn bẩy

        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        quantity = Math.max(minQty, quantity); 

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Giá trị hợp đồng (${currentNotional.toFixed(pricePrecision)} USDT) quá nhỏ so với minNotional (${minNotional} USDT) cho ${symbol}. Không mở lệnh.`);
            addLog(`   Vốn USDT đầu tư: ${capitalToUse.toFixed(2)} USDT. Vị thế ước tính (đòn bẩy ${maxLeverage}x): ${currentNotional.toFixed(2)} USDT.`);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Khối lượng tính toán cho ${symbol} là ${quantity}. Quá nhỏ hoặc không hợp lệ. Không mở lệnh.`);
            if(botRunning) scheduleNextMainCycle(); // Quay lại chế độ chờ
            return;
        }

        // 5. Thực hiện lệnh mở vị thế SHORT (SELL MARKET)
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL', 
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' 
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice);
        const openTime = new Date();
        // Định dạng thời gian mở lệnh theo UTC+7
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
        const formattedOpenTime = formatter.format(openTime);
        
        addLog(`✅ Đã mở lệnh SHORT thành công cho ${symbol} vào lúc ${formattedOpenTime}`);
        addLog(`  + Funding Rate: ${fundingRate}`);
        addLog(`  + Đòn bẩy sử dụng: ${maxLeverage}x`);
        addLog(`  + Vốn USDT vào lệnh: ${capitalToUse.toFixed(2)} USDT`);
        addLog(`  + Khối lượng: ${quantity} ${symbol}`);
        addLog(`  + Giá vào lệnh: ${entryPrice.toFixed(pricePrecision)}`);
        
        // 6. Tính toán TP/SL theo yêu cầu mới (dựa trên vốn đầu tư ban đầu)
        const slAmountUSDT = capitalToUse * STOP_LOSS_PERCENTAGE; // Số tiền SL dựa trên vốn đầu tư
        const tpPercentage = TAKE_PROFIT_PERCENTAGES[maxLeverage] || 0; // Lấy TP % theo maxLeverage
        const tpAmountUSDT = capitalToUse * tpPercentage; // Số tiền TP dựa trên vốn đầu tư

        // SL cho lệnh SHORT: giá tăng lên (giá hòa vốn + (số tiền SL / khối lượng))
        let slPrice = entryPrice + (slAmountUSDT / quantity); 
        // TP cho lệnh SHORT: giá giảm xuống (giá hòa vốn - (số tiền TP / khối lượng))
        let tpPrice = entryPrice - (tpAmountUSDT / quantity); 
        
        // Làm tròn TP/SL theo tickSize của sàn
        slPrice = Math.ceil(slPrice / tickSize) * tickSize; // SL luôn làm tròn lên
        tpPrice = Math.floor(tpPrice / tickSize) * tickSize; // TP luôn làm tròn xuống

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        addLog(`>>> Giá TP: ${tpPrice.toFixed(pricePrecision)}, Giá SL: ${slPrice.toFixed(pricePrecision)}`);
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
        positionCheckInterval = setInterval(async () => {
            if(botRunning) { // Chỉ quản lý vị thế nếu bot đang chạy
                await manageOpenPosition();
            } else { // Nếu bot bị dừng khi đang có vị thế, dừng interval
                clearInterval(positionCheckInterval);
                positionCheckInterval = null;
            }
        }, 1000); // Kiểm tra mỗi giây

    } catch (error) {
        addLog(`❌ Lỗi khi mở lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
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
            if(botRunning) scheduleNextMainCycle(); // Lên lịch quét mới nếu không còn vị thế
        }
        return; 
    }

    const { symbol, quantity, tpPrice, slPrice, openTime, pricePrecision } = currentOpenPosition;

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
            // Không log gì nếu không lấy được giá, chỉ cập nhật dòng cũ
            process.stdout.write(`\r>>> Đang kiểm tra vị thế ${symbol} (${quantity}). Đã mở ${elapsedTimeSeconds.toFixed(0)}/${MAX_POSITION_LIFETIME_SECONDS} giây. (Đang lấy giá...)     `);
            return;
        }
        
        // Log đếm ngược thời gian còn lại trên cùng một dòng
        const timeLeft = MAX_POSITION_LIFETIME_SECONDS - Math.floor(elapsedTimeSeconds);
        const statusMessage = `\r>>> Vị thế ${symbol}: Đang mở, còn lại ${timeLeft} giây. Giá hiện tại: ${currentPrice.toFixed(pricePrecision)} | TP: ${tpPrice.toFixed(pricePrecision)} | SL: ${slPrice.toFixed(pricePrecision)}           `;
        
        process.stdout.write(statusMessage); // In ra console
        if (wsClient && wsClient.readyState === wsClient.OPEN) { // Gửi qua WebSocket
            wsClient.send(JSON.stringify({ type: 'status', message: `Bot Status: ${statusMessage}` }));
        }

        let shouldClose = false;
        let closeReason = '';

        if (currentPrice <= tpPrice) {
            addLog(`\n✅ Vị thế ${symbol} đạt TP tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`);
            shouldClose = true;
            closeReason = 'TP';
        } else if (currentPrice >= slPrice) {
            addLog(`\n❌ Vị thế ${symbol} đạt SL tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`);
            shouldClose = true;
            closeReason = 'SL';
        } else if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`\n⏱️ Vị thế ${symbol} vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`);
            shouldClose = true;
            closeReason = 'Hết thời gian';
        }

        if (shouldClose) {
            isClosingPosition = true; // Đặt cờ để ngăn các lệnh đóng trùng lặp
            await closeShortPosition(symbol, quantity, closeReason);
            isClosingPosition = false; // Xóa cờ sau khi hoàn tất
        }

    } catch (error) {
        addLog(`\n❌ Lỗi khi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        isClosingPosition = false; // Đảm bảo cờ được xóa ngay cả khi có lỗi
    }
}

// Hàm chạy logic tìm kiếm cơ hội
async function runTradingLogic(isFundingScanFlag) {
    if (!botRunning) { // Kiểm tra nếu bot đã bị dừng khi đang chờ
        addLog('Bot đã bị dừng. Hủy bỏ runTradingLogic.', true);
        return;
    }
    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Bỏ qua tìm kiếm cơ hội mới.');
        return; 
    }

    // Nếu không phải là phiên quét cho giờ funding, chỉ ngủ và lên lịch lại
    if (!isFundingScanFlag) {
        addLog('>>> Hiện tại không phải là phiên quét chuẩn bị cho giờ trả Funding. Bot sẽ ngủ tới phiên quét Funding tiếp theo.');
        if(botRunning) scheduleNextMainCycle();
        return;
    }

    addLog('>>> Đang quét tìm symbol có funding rate âm...');
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset); // Đảm bảo là số

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu (${MIN_USDT_BALANCE_TO_OPEN}). Không tìm kiếm cơ hội.`);
            if(botRunning) scheduleNextMainCycle();
            return;
        }

        const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
        
        const candidates = [];
        for (const item of allFundingData) {
            const fundingRate = parseFloat(item.lastFundingRate);
            if (fundingRate < MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                const symbolInfo = await getSymbolFiltersAndMaxLeverage(item.symbol);
                if (symbolInfo && typeof symbolInfo.maxLeverage === 'number' && symbolInfo.maxLeverage > 1) {
                    // Kiểm tra xem có đủ minNotional để mở lệnh không (sau khi tính toán vốn và đòn bẩy)
                    const estimatedCapitalAtMaxLeverage = (availableBalance * CAPITAL_PERCENTAGE_PER_TRADE) * symbolInfo.maxLeverage;
                    if (estimatedCapitalAtMaxLeverage >= symbolInfo.minNotional) {
                        // Kiểm tra xem maxLeverage có nằm trong các TP được định nghĩa không
                        if (TAKE_PROFIT_PERCENTAGES[symbolInfo.maxLeverage] !== undefined) {
                            candidates.push({
                                symbol: item.symbol,
                                fundingRate: fundingRate,
                                nextFundingTime: item.nextFundingTime, // Thời gian funding tiếp theo
                                maxLeverage: symbolInfo.maxLeverage
                            });
                        } else {
                            addLog(`[DEBUG] ${item.symbol}: Đòn bẩy tối đa (${symbolInfo.maxLeverage}x) không có cấu hình TP. Bỏ qua.`);
                        }
                    } else {
                        addLog(`[DEBUG] ${item.symbol}: Vốn (${availableBalance.toFixed(2)}) * Đòn bẩy (${symbolInfo.maxLeverage}x) không đủ MinNotional (${symbolInfo.minNotional}). Bỏ qua.`);
                    }
                }
            }
        }

        if (candidates.length > 0) {
            candidates.sort((a, b) => a.fundingRate - b.fundingRate);
            const selectedCandidate = candidates[0]; // Lấy ứng viên tốt nhất (funding rate âm nhất)

            const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
            const currentPrice = await getCurrentPrice(selectedCandidate.symbol);
            if (!currentPrice) {
                addLog(`❌ Không thể lấy giá hiện tại cho ${selectedCandidate.symbol}. Bỏ qua cơ hội này.`);
                if(botRunning) scheduleNextMainCycle();
                return;
            }
            
            let estimatedQuantity = (capitalToUse * selectedCandidate.maxLeverage) / currentPrice;
            const symbolInfo = exchangeInfoCache[selectedCandidate.symbol]; // Lấy từ cache
            if (symbolInfo) {
                estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
            }

            const now = new Date();
            // Lệnh sẽ được mở vào giờ funding tiếp theo (ví dụ nếu đang 07:58, sẽ mở 08:00:00:100)
            let finalOrderOpenTime = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 
                                        now.getUTCHours() + 1, OPEN_ORDER_MINUTE_UTC, TARGET_SECOND_UTC, TARGET_MILLISECOND_UTC);
            
            // Đảm bảo thời gian mở lệnh là đúng
            if (finalOrderOpenTime.getTime() <= now.getTime()) {
                // Nếu vì lý do nào đó mà thời gian đã qua, thì chuyển sang giờ tiếp theo nữa (ví dụ: quét 07:59:59, nhưng giờ mở lệnh 08:00:00:100 vẫn sau)
                finalOrderOpenTime.setUTCHours(finalOrderOpenTime.getUTCHours() + 1);
                // Đảm bảo các thành phần phút, giây, mili giây đúng
                finalOrderOpenTime.setUTCMinutes(OPEN_ORDER_MINUTE_UTC);
                finalOrderOpenTime.setUTCSeconds(TARGET_SECOND_UTC);
                finalOrderOpenTime.setUTCMilliseconds(TARGET_MILLISECOND_UTC);
            }

            const timeLeftMs = finalOrderOpenTime.getTime() - now.getTime();
            const timeLeftSeconds = Math.max(0, Math.ceil(timeLeftMs / 1000));

            // Định dạng thời gian hiển thị cho người dùng theo UTC+7
            const formatter = new Intl.DateTimeFormat('en-GB', {
                year: 'numeric',
                month: '2-digit',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                fractionalSecondDigits: 3,
                hour12: false,
                timeZone: 'Asia/Ho_Chi_Minh' // Múi giờ Việt Nam
            });
            const formattedFinalOrderOpenTime = formatter.format(finalOrderOpenTime);


            addLog(`\n✅ Đã chọn đồng coin: **${selectedCandidate.symbol}**`);
            addLog(`  + Funding Rate: **${selectedCandidate.fundingRate}**`);
            addLog(`  + Đòn bẩy tối đa: **${selectedCandidate.maxLeverage}x**`);
            addLog(`  + Số tiền dự kiến mở lệnh: **${capitalToUse.toFixed(2)} USDT** (Khối lượng ước tính: **${estimatedQuantity} ${selectedCandidate.symbol}**)`);
            addLog(`  + Lệnh sẽ được mở vào lúc **${formattedFinalOrderOpenTime}** (còn khoảng **${timeLeftSeconds} giây** đếm ngược).`);
            
            addLog(`>>> Đang chờ đến thời điểm mở lệnh...`);

            if (timeLeftMs > 0) {
                await delay(timeLeftMs);
            }
            
            // Sau khi chờ, kiểm tra lại xem có vị thế nào được mở trong khi chờ không và bot vẫn đang chạy
            if (!currentOpenPosition && botRunning) {
                await openShortPosition(selectedCandidate.symbol, selectedCandidate.fundingRate, availableBalance);
            } else if (!botRunning) {
                addLog('Bot đã bị dừng trong khi chờ mở lệnh. Hủy bỏ việc mở lệnh.', true);
            } else {
                addLog(`⚠️ Đã có vị thế được mở trong khi chờ (bởi luồng khác). Bỏ qua việc mở lệnh mới.`);
                // Vì đã có lệnh khác mở, không cần lên lịch quét lại ngay,
                // manageOpenPosition sẽ lo việc đóng lệnh và sau đó gọi scheduleNextMainCycle.
            }

        } else {
            addLog('>>> Không tìm thấy cơ hội Shorting với funding rate đủ tốt. Bot sẽ ngủ cho đến phiên quét tiếp theo.');
            if(botRunning) scheduleNextMainCycle();
        }
    } catch (error) {
        addLog(`❌ Lỗi trong runTradingLogic: ${error.msg || error.message}`);
        if(botRunning) scheduleNextMainCycle();
    }
}

// Hàm lên lịch chu kỳ chính của bot (quét hoặc chờ)
async function scheduleNextMainCycle() {
    clearTimeout(nextScheduledTimeout); // Xóa bất kỳ lịch trình cũ nào

    if (!botRunning) { // Nếu bot đã bị dừng, không lên lịch nữa
        addLog('Bot đã dừng. Hủy lịch trình tiếp theo.', true);
        return;
    }

    if (currentOpenPosition) {
        return; // Managed by manageOpenPosition
    }
    
    const now = new Date();
    let nextScanMoment = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 
                                   now.getUTCHours(), SCAN_MINUTE_UTC, TARGET_SECOND_UTC, TARGET_MILLISECOND_UTC);
    
    // Nếu thời gian hiện tại đã qua phút quét (XX:58), chuyển sang giờ tiếp theo để quét
    if (now.getUTCMinutes() >= SCAN_MINUTE_UTC) {
        nextScanMoment.setUTCHours(nextScanMoment.getUTCHours() + 1);
    }
    // Đảm bảo giây và mili giây được đặt lại cho thời điểm quét
    nextScanMoment.setUTCSeconds(0);
    nextScanMoment.setUTCMilliseconds(0);

    let nextScheduledRunTime = nextScanMoment;
    let isFundingScan = false;
    let targetOrderOpenHourUTC = (nextScanMoment.getUTCHours() + 1) % 24; // Giờ mà lệnh sẽ được mở (ví dụ: quét 07:58 -> mở 08:00)

    // Kiểm tra xem giờ mà lệnh sẽ được mở có phải là giờ Funding không
    if (FUNDING_HOURS_UTC.includes(targetOrderOpenHourUTC)) {
        isFundingScan = true;
        addLog(`>>> Lịch trình: Phiên quét sắp tới (${formatTimeUTC7(nextScanMoment)}) là để chuẩn bị cho giờ Funding **${targetOrderOpenHourUTC}:00 UTC**.`);
    } else {
        // Nếu không phải giờ Funding, tìm giờ Funding kế tiếp
        addLog(`>>> Lịch trình: Phiên quét ${formatTimeUTC7(nextScanMoment)} không phải cho giờ Funding. Tìm phiên quét Funding kế tiếp.`);
        isFundingScan = false;
        let foundNextFundingScan = false;
        let tempScanTime = new Date(nextScanMoment.getTime()); // Bắt đầu từ thời gian quét được tính hiện tại

        while (!foundNextFundingScan) {
            tempScanTime.setUTCHours(tempScanTime.getUTCHours() + 1); // Kiểm tra giờ tiếp theo
            tempScanTime.setUTCMinutes(SCAN_MINUTE_UTC);
            tempScanTime.setUTCSeconds(0);
            tempScanTime.setUTCMilliseconds(0);

            let potentialOrderOpenHourForTemp = (tempScanTime.getUTCHours() + 1) % 24;
            if (FUNDING_HOURS_UTC.includes(potentialOrderOpenHourForTemp)) {
                foundNextFundingScan = true;
                nextScheduledRunTime = tempScanTime;
                targetOrderOpenHourUTC = potentialOrderOpenHourForTemp;
            }
            if (tempScanTime.getTime() > now.getTime() + (24 * 60 * 60 * 1000 * 2)) { // Giới hạn tìm kiếm trong 2 ngày
                addLog('⚠️ Không tìm thấy giờ Funding trong 2 ngày tới. Vui lòng kiểm tra lại cấu hình.');
                break; // Thoát vòng lặp để tránh vòng lặp vô hạn
            }
        }
        addLog(`>>> Bot sẽ ngủ tới phiên quét Funding tiếp theo vào: **${formatTimeUTC7(nextScheduledRunTime)}** (để mở lệnh vào giờ Funding **${targetOrderOpenHourUTC}:00 UTC**).`);
    }
    
    const delayMs = nextScheduledRunTime.getTime() - now.getTime();

    if (delayMs < 0) { // Trường hợp đặc biệt nếu tính toán bị âm (hiếm khi xảy ra với logic trên)
        addLog(`⚠️ [Lỗi Lịch trình] Thời gian chờ âm: ${delayMs} ms. Đang điều chỉnh lại.`);
        // Nếu thời gian đã qua, lên lịch lại ngay lập tức
        if(botRunning) scheduleNextMainCycle();
        return;
    }

    addLog(`>>> Bot sẽ chạy logic quét vào lúc: ${formatTimeUTC7(nextScheduledRunTime)}.`);
    
    nextScheduledTimeout = setTimeout(async () => {
        if(botRunning) { // Chỉ chạy nếu bot vẫn đang hoạt động
            await runTradingLogic(isFundingScan); // Truyền cờ isFundingScan
        } else {
            addLog('Bot đã bị dừng. Hủy bỏ việc thực thi lịch trình.', true);
        }
    }, delayMs);
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


// --- Hàm khởi động bot ---
async function startBot() {
    if (botRunning) {
        addLog('Bot đã và đang chạy rồi. Không khởi động lại.', true);
        return;
    }
    botRunning = true;
    botStartTime = new Date();
    addLog('--- Khởi động Bot Futures Funding Rate ---');
    addLog('>>> Đang kiểm tra kết nối API Key với Binance Futures...');
    
    // Kiểm tra API Key và Secret Key đã được thay thế chưa
    if (API_KEY === 'DÁN_API_KEY_CỦA_BẠN_VÀO_ĐÂY' || SECRET_KEY === 'DÁN_SECRET_KEY_CỦA_BẠN_VÀO_ĐÂY') {
        addLog('❌ LỖI CẤU HÌNH: Vui lòng thay thế "DÁN_API_KEY_CỦA_BẠN_VÀO_ĐÂY" và "DÁN_SECRET_KEY_CỦA_BẠN_VÀO_ĐÂY" bằng API Key và Secret Key THẬT của bạn.');
        botRunning = false;
        return; // Dừng bot nếu cấu hình sai
    }

    try {
        await syncServerTime(); // Đồng bộ thời gian trước

        // Kiểm tra API Key bằng cách lấy thông tin tài khoản
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key hoạt động bình thường! Số dư USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`);

        // Load exchange info một lần khi khởi động
        await getExchangeInfo(); 
        if (!exchangeInfoCache) { 
            addLog('❌ Không thể tải thông tin sàn (exchangeInfo). Bot sẽ dừng.');
            botRunning = false;
            return;
        }

        // Bắt đầu chu kỳ chính của bot (quét hoặc chờ)
        scheduleNextMainCycle();

        // Thiết lập kiểm tra vị thế định kỳ (dù không có lệnh vẫn chạy để đảm bảo
        // nếu có lệnh mở từ đâu đó thì cũng được quản lý)
        // Lưu ý: interval này chỉ chạy nếu botRunning là true
        if(!positionCheckInterval) { // Chỉ tạo interval nếu chưa có
            positionCheckInterval = setInterval(async () => {
                if (botRunning) { // Chỉ chạy nếu bot vẫn đang hoạt động
                    await manageOpenPosition();
                } else {
                    clearInterval(positionCheckInterval); // Dừng interval nếu bot dừng
                    positionCheckInterval = null;
                }
            }, 1000); // Kiểm tra mỗi giây
        }
        
    } catch (error) {
        addLog('❌ [Lỗi nghiêm trọng khi khởi động bot] ' + (error.msg || error.message));
        addLog('   -> Bot sẽ dừng hoạt động. Vui lòng kiểm tra và khởi động lại.');
        addLog('   -> Gợi ý: Nếu lỗi là "-1022 Signature for this request is not valid.", hãy kiểm tra lại API Key/Secret và đặc biệt là danh sách IP trắng trên Binance.');
        addLog('   -> Gợi ý: Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", hãy kiểm tra lại đồng bộ thời gian trên VPS (`sudo ntpdate pool.ntp.org` và `timedatectl status`).');
        botRunning = false; // Đảm bảo cờ được đặt lại nếu có lỗi khởi động
    }
}

// --- Hàm dừng bot ---
function stopBot() {
    if (!botRunning) {
        addLog('Bot hiện không chạy. Không cần dừng.', true);
        return;
    }
    botRunning = false;
    clearTimeout(nextScheduledTimeout); // Hủy lịch trình tiếp theo
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval); // Dừng kiểm tra vị thế
        positionCheckInterval = null;
    }
    addLog('--- Bot đã được dừng ---');
    botStartTime = null;
    if (wsClient && wsClient.readyState === wsClient.OPEN) {
        wsClient.send(JSON.stringify({ type: 'status', message: 'Bot Status: Bot has been STOPPED.' }));
    }
}
