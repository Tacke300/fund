/***************** CẤU HÌNH CHUNG  *****************/
import express from 'express';
import https from 'https'; // Giữ lại module https mà bạn đang dùng
import crypto from 'crypto';
import path from 'path';
import cron from 'node-cron';

// Để thay thế __dirname trong ES Modules
import { fileURLToPath }  from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

// === API KEY & SECRET ===
// !!! QUAN TRỌNG: ĐẢM BẢO ĐÂY LÀ API KEY VÀ SECRET KEY THẬT CỦA BẠN !!!
// Đã thêm .trim() để loại bỏ bất kỳ khoảng trắng thừa nào.
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); 
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fccDf0pEnFzoTc'.trim(); 

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_HOST = 'fapi.binance.com';

// Biến này sẽ không được dùng trong signedRequest/publicRequest nữa,
// nhưng tôi vẫn giữ lại để tương thích nếu bạn muốn đồng bộ thời gian thủ công sau này.
let serverTimeOffset = 0; 

/***************** HÀM TIỆN ÍCH CHUNG *****************/
let logs = [];
let botRunning = false;
let selectedSymbol = null;
let exchangeInfoCache = null;

function addLog(message) {
  const now = new Date();
  const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const logEntry = `[${time}] ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 1000) logs.shift(); // Giới hạn số lượng log
}

const delay = ms => new Promise(resolve => setTimeout(ms));

/***************** CÁC HÀM API CHÍNH (SAO CHÉP NGUYÊN BẢN LOGIC TỪ TEST.JS CỦA BẠN) *****************/

/**
 * Tạo chữ ký HMAC SHA256 cho chuỗi truy vấn.
 * (Sao chép nguyên bản từ test.js)
 */
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                 .update(queryString)
                 .digest('hex');
}

/**
 * Hàm helper để gửi yêu cầu HTTP.
 * (Sao chép nguyên bản từ test.js, với việc bổ sung `postData` cho POST requests một cách linh hoạt)
 * @param {string} method - Phương thức HTTP (GET, POST).
 * @param {string} hostname - Hostname của API (ví dụ: 'fapi.binance.com').
 * @param {string} path - Đường dẫn của API (ví dụ: '/fapi/v1/account') bao gồm query string cho GET.
 * @param {object} headers - Các HTTP headers.
 * @param {string} postData - Dữ liệu body cho POST request.
 * @returns {Promise<string>} Dữ liệu phản hồi dạng chuỗi JSON.
 */
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

/**
 * Gửi yêu cầu ĐÃ KÝ tới API Binance Futures.
 * (Sao chép nguyên bản logic từ `signedRequest` của `test.js`)
 * @param {string} fullEndpointPath - Đường dẫn đầy đủ của API (ví dụ: '/fapi/v2/account').
 * @param {string} method - Phương thức HTTP (GET, POST).
 * @param {object} params - Các tham số truy vấn.
 * @returns {Promise<object>} Dữ liệu trả về từ API.
 */
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const recvWindow = 5000;
    const timestamp = Date.now(); 

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    // Chú ý: Ở đây mình gộp timestamp và recvWindow vào queryString trước khi ký
    // Đảm bảo đúng thứ tự như test.js của bạn nếu nó có thứ tự cố định.
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);
    
    let requestPath;
    let requestBody = ''; // Dữ liệu cho body của POST request
    const headers = {
        'X-MBX-APIKEY': API_KEY,
    };

    if (method === 'GET') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json'; // Hoặc bỏ qua nếu test.js không set
    } else if (method === 'POST') {
        // Đối với POST, signature và các tham số sẽ nằm trong body.
        requestPath = fullEndpointPath; // Đường dẫn API không có query string
        requestBody = `${queryString}&signature=${signature}`; // Toàn bộ query string và signature đi vào body
        headers['Content-Type'] = 'application/x-www-form-urlencoded'; // Rất quan trọng cho POST
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
        }
        else if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
             addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

/**
 * Gửi yêu cầu GET KHÔNG ký tới API Binance Futures (cho các endpoint công khai).
 * (Sao chép nguyên bản logic từ `publicRequest` của `test.js`)
 * @param {string} fullEndpointPath - Đường dẫn đầy đủ của API (ví dụ: '/fapi/v1/exchangeInfo').
 * @param {object} params - Các tham số truy vấn.
 * @returns {Promise<object>} Dữ liệu trả về từ API.
 */
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

/**
 * Hàm để lấy thời gian server Binance và tính toán độ lệch.
 * (Giữ lại hàm này để lấy offset, nhưng offset sẽ không được sử dụng bởi callSignedAPI/callPublicAPI nữa)
 */
async function syncServerTime() {
  try {
    const data = await callPublicAPI('/fapi/v1/time');
    const binanceServerTime = data.serverTime;
    const localTime = Date.now();
    serverTimeOffset = binanceServerTime - localTime;
    addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms. (Lưu ý: Độ lệch này hiện không được dùng bởi các hàm API chính mà chỉ để ghi log)`);
  } catch (error) {
    addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}.`);
    serverTimeOffset = 0; 
  }
}

/**
 * Lấy thông tin đòn bẩy cho một symbol cụ thể từ endpoint /fapi/v1/leverageBracket.
 * (Sao chép nguyên bản logic từ test.js)
 * @param {string} symbol - Tên cặp giao dịch (ví dụ: 'BTCUSDT').
 * @returns {Promise<number|null>} Đòn bẩy tối đa (ví dụ: 125) hoặc null nếu không tìm thấy hoặc lỗi.
 */
async function getLeverageBracketForSymbol(symbol) {
    try {
        addLog(`[DEBUG getLeverageBracketForSymbol] Đang cố gắng lấy leverageBracket cho ${symbol} theo cách của test.js...`);
        // Lời gọi đến callSignedAPI (đã là signedRequest được đổi tên)
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });

        if (response && Array.isArray(response) && response.length > 0 && response[0].brackets && response[0].brackets.length > 0) {
            const firstBracket = response[0].brackets[0]; // Lấy bracket đầu tiên
            if (firstBracket.maxInitialLeverage !== undefined) {
                const maxLev = parseInt(firstBracket.maxInitialLeverage);
                addLog(`[DEBUG getLeverageBracketForSymbol] Đã lấy được đòn bẩy ${maxLev}x cho ${symbol} (từ maxInitialLeverage).`);
                return maxLev;
            } else if (firstBracket.initialLeverage !== undefined) {
                const maxLev = parseInt(firstBracket.initialLeverage);
                addLog(`[DEBUG getLeverageBracketForSymbol] Đã lấy được đòn bẩy ${maxLev}x cho ${symbol} (từ initialLeverage của bracket đầu tiên).`);
                return maxLev;
            }
        }
        addLog(`[DEBUG getLeverageBracketForSymbol] Không tìm thấy thông tin đòn bẩy hợp lệ cho ${symbol} từ response.`);
        return null; // Trả về null nếu không tìm thấy
    } catch (error) {
        addLog(`❌ Lỗi khi lấy getLeverageBracketForSymbol cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}


/***************** ROUTES HTTP  *****************/
app.use(express.json());
app.use('/bot', express.static(path.join(__dirname)));
app.get('/', (req, res) => res.send('Funding bot is running!'));

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> /balance được gọi');
    // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js)
    const account = await callSignedAPI('/fapi/v2/account', 'GET'); 
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    res.json({ balance: usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0 });
  } catch (error) {
    addLog('Lỗi trong /balance: ' + (error.msg || error.message));
    res.status(500).json({ error: error.msg || error.message });
  }
});

app.get('/funding', async (req, res) => {
  try {
    // Sử dụng callPublicAPI (đã gộp từ publicRequest của test.js)
    const fundingRates = await callPublicAPI('/fapi/v1/premiumIndex');

    const simplified = fundingRates.map(item => ({
      symbol: item.symbol,
      fundingRate: parseFloat(item.lastFundingRate),
      time: new Date(parseInt(item.nextFundingTime)).toLocaleString('en-GB')
    }));
    res.json(simplified);
  } catch (error) {
    res.status(500).json({ error: error.msg || error.message });
  }
});

app.get('/start', (req, res) => {
  if (!botRunning) {
    botRunning = true;
    addLog('>>> Bot bắt đầu múa');
    res.send('Bot started');
  } else {
    res.send('Bot is already running');
  }
});

app.get('/stop', (req, res) => {
  if (botRunning) {
    botRunning = false;
    addLog('>>> Bot đã đắp mộ cuộc tình');
    res.send('Bot stopped');
  } else {
    res.send('Bot is not running');
  }
});

app.get('/status', (req, res) => {
  addLog('>>> Gọi API /status');
  res.json({ running: botRunning, currentSymbol: selectedSymbol, logCount: logs.length });
});

app.get('/logs', (req, res) => {
  res.json(logs);
});

app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`);
  addLog(`Server started on port ${port}`);
  // Đồng bộ thời gian ngay khi khởi động
  await syncServerTime();
  // Đồng bộ thời gian định kỳ mỗi giờ
  cron.schedule('0 * * * *', async () => {
      addLog('[Cron] Đồng bộ lại thời gian server Binance.');
      await syncServerTime();
  });
});

/***************** HÀM LẤY THÔNG TIN SÀN  *****************/

async function getExchangeInfo() {
  if (exchangeInfoCache) {
    addLog('>>> Đã có cache exchangeInfo. Trả về cache.');
    return exchangeInfoCache;
  }

  addLog('>>> Đang lấy exchangeInfo từ Binance...');
  try {
    // Sử dụng callPublicAPI (đã gộp từ publicRequest của test.js)
    const data = await callPublicAPI('/fapi/v1/exchangeInfo');
    addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`);

    exchangeInfoCache = {};
    data.symbols.forEach(s => {
      const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
      const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
      const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

      exchangeInfoCache[s.symbol] = {
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
        maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.maxQty) : Infinity),
        stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision
      };
    });
    addLog('>>> Đã tải thông tin sàn và cache thành công.');
    return exchangeInfoCache;
  } catch (error) {
    addLog('Lỗi khi lấy exchangeInfo: ' + (error.msg || error.message));
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
  
  // Sử dụng getLeverageBracketForSymbol (đã gộp từ test.js)
  const maxLeverage = await getLeverageBracketForSymbol(symbol); 

  return {
    ...filters[symbol],
    maxLeverage: maxLeverage // Thêm maxLeverage vào đối tượng filters
  };
}


async function getCurrentPrice(symbol) {
  try {
    // Sử dụng callPublicAPI (đã gộp từ publicRequest của test.js)
    const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
    const price = parseFloat(data.price);
    return price;
  } catch (error) {
    addLog(`Lỗi khi lấy giá cho ${symbol}: ` + (error.msg || error.message));
    return null;
  }
}

/***************** ĐẶT & ĐÓNG LỆNH  *****************/
async function placeShortOrder(symbol, currentFundingRate, bestFundingTime) {
  try {
    // Lấy số dư hiện tại của bạn
    addLog('>>> Đang kiểm tra số dư khả dụng...');
    // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js)
    const account = await callSignedAPI('/fapi/v2/account', 'GET');
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    const balance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
    addLog(`Số dư khả dụng hiện tại: ${balance.toFixed(2)} USDT`);

    if (balance < 0.15) {
      addLog(`>>> Không đủ balance để mở lệnh. Balance hiện tại: ${balance} USDT`);
      return;
    }

    // Lấy tất cả thông tin cần thiết cho symbol (filters và maxLeverage)
    const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
    
    if (!symbolInfo || typeof symbolInfo.maxLeverage !== 'number' || symbolInfo.maxLeverage <= 1) {
        addLog(`>>> Lỗi: Không có thông tin đòn bẩy hợp lệ cho ${symbol} khi mở lệnh. (MaxLeverage: ${symbolInfo ? symbolInfo.maxLeverage : 'N/A'})`);
        return;
    }

    const maxLeverage = symbolInfo.maxLeverage;
    const price = await getCurrentPrice(symbol);
    if (!price) {
        addLog(`Không thể lấy giá cho ${symbol}. Hủy mở lệnh.`);
        return;
    }

    // Đặt đòn bẩy cho symbol này
    addLog(`[DEBUG] Đang đặt đòn bẩy. symbol: ${symbol}, leverage: ${maxLeverage}`);
    // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js), truyền method POST
    await callSignedAPI('/fapi/v1/leverage', 'POST', {
      symbol: symbol,
      leverage: maxLeverage
    });
    addLog(`Đã đặt đòn bẩy ${maxLeverage}x cho ${symbol}.`);

    const capital = balance * 0.8; // 80% vốn
    // Công thức tính quantity: (vốn * đòn bẩy) / giá
    let quantity = (capital * maxLeverage) / price;

    const minQty = symbolInfo.minQty;
    const maxQty = symbolInfo.maxQty;
    const stepSize = symbolInfo.stepSize;
    const minNotional = symbolInfo.minNotional;
    const quantityPrecision = symbolInfo.quantityPrecision;

    // Điều chỉnh quantity theo stepSize và precision
    quantity = Math.floor(quantity / stepSize) * stepSize;
    quantity = parseFloat(quantity.toFixed(quantityPrecision));
    quantity = Math.max(minQty, Math.min(maxQty, quantity));

    const currentNotional = quantity * price;
    if (currentNotional < minNotional) {
        addLog(`Giá trị notional (${currentNotional.toFixed(symbolInfo.pricePrecision)}) cho ${symbol} quá thấp. Cần tối thiểu ${minNotional} USDT. Hủy mở lệnh.`);
        return;
    }

    if (quantity <= 0) {
      addLog(`Số lượng tính toán cho ${symbol} quá nhỏ hoặc bằng 0: ${quantity}. Hủy mở lệnh.`);
      return;
    }

    // Đặt lệnh SHORT (SELL) MARKET
    addLog(`[DEBUG] Đang đặt lệnh SHORT. symbol: ${symbol}, quantity: ${quantity}`);
    // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js), truyền method POST
    const order = await callSignedAPI('/fapi/v1/order', 'POST', {
      symbol: symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity
    });

    // Thông tin sau khi lệnh được mở thành công (log này sẽ hiển thị nếu lệnh thành công)
    const openTime = new Date();
    const formattedOpenTime = `${openTime.toLocaleDateString('en-GB')} ${openTime.toLocaleTimeString('en-US', { hour12: false })}.${String(openTime.getMilliseconds()).padStart(3, '0')}`;
    addLog(`Lệnh mở lúc: ${formattedOpenTime}`);
    addLog(`>>> Đã mở lệnh SHORT thành công cho ${symbol}`);
    addLog(`  + Funding Rate: ${currentFundingRate}`);
    addLog(`  + Đòn bẩy sử dụng: ${maxLeverage}x`);
    addLog(`  + Số tiền USDT vào lệnh: ${capital.toFixed(2)} USDT`);
    addLog(`  + Khối lượng: ${quantity} ${symbol}`);
    addLog(`  + Giá vào lệnh: ${parseFloat(order.avgFillPrice || price).toFixed(symbolInfo.pricePrecision)}`);


    const entryPrice = parseFloat(order.avgFillPrice || price);
    const riskPercentage = 0.01; // 1% rủi ro/lợi nhuận trên tổng giá trị vị thế
    const tpSlAmount = (capital * maxLeverage) * riskPercentage; 
    
    const tpPrice = entryPrice - (tpSlAmount / quantity); // SHORT: TP thấp hơn giá vào
    const slPrice = entryPrice + (tpSlAmount / quantity); // SHORT: SL cao hơn giá vào

    addLog(`>>> Giá TP: ${tpPrice.toFixed(symbolInfo.pricePrecision)}, Giá SL: ${slPrice.toFixed(symbolInfo.pricePrecision)}`);

    let checkCount = 0;
    const maxCheck = 180; // 3 phút (180 giây)

    addLog(`Lệnh sẽ đóng sau ${maxCheck} giây hoặc khi đạt TP/SL.`);

    const checkInterval = setInterval(async () => {
      if (!botRunning) {
        clearInterval(checkInterval);
        addLog(`Watcher cho ${symbol} dừng do bot đã tắt.`);
        return;
      }
      try {
        checkCount++;
        const currentPrice = await getCurrentPrice(symbol);

        process.stdout.write(`>>> Đang kiểm tra TP/SL cho ${symbol}... Đã kiểm tra ${checkCount} / ${maxCheck} giây     \r`);

        if (currentPrice !== null) { 
          if (currentPrice <= tpPrice) {
            addLog(`\n>>> Giá đạt TP: ${currentPrice.toFixed(symbolInfo.pricePrecision)}. Đóng lệnh ngay.`);
            clearInterval(checkInterval);
            await closeShortPosition(symbol, quantity);
          } else if (currentPrice >= slPrice) {
            addLog(`\n>>> Giá đạt SL: ${currentPrice.toFixed(symbolInfo.pricePrecision)}. Đóng lệnh ngay.`);
            clearInterval(checkInterval);
            await closeShortPosition(symbol, quantity);
          } else if (checkCount >= maxCheck) {
            addLog(`\n>>> Quá ${maxCheck} giây chưa đạt TP/SL. Đóng lệnh.`);
            clearInterval(checkInterval);
            await closeShortPosition(symbol, quantity);
          }
        }
      } catch (error) {
        addLog('Lỗi khi check TP/SL: ' + (error.msg || error.message));
      }
    }, 1000); // Kiểm tra mỗi giây
  } catch (error) {
    addLog('Lỗi mở lệnh short: ' + (error.msg || error.message));
  }
}

async function closeShortPosition(symbol, qtyToClose = null) {
  try {
    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol}`);
    // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js)
    const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET'); 
    const position = positions.find(p => p.symbol === symbol);

    if (position && parseFloat(position.positionAmt) !== 0) {
      const currentPositionQty = Math.abs(parseFloat(position.positionAmt));
      if (qtyToClose === null || qtyToClose > currentPositionQty) {
        qtyToClose = currentPositionQty;
      }

      const closePrice = await getCurrentPrice(symbol);
      if (!closePrice) {
          addLog(`Không thể lấy giá đóng lệnh cho ${symbol}. Hủy đóng lệnh.`);
          return;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
      const quantityPrecision = symbolInfo ? symbolInfo.quantityPrecision : 3;

      qtyToClose = parseFloat(qtyToClose.toFixed(quantityPrecision));

      addLog(`[DEBUG] Đang đóng lệnh SHORT. symbol: ${symbol}, quantity: ${qtyToClose}`);
      // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js), truyền method POST
      await callSignedAPI('/fapi/v1/order', 'POST', {
        symbol: symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: qtyToClose,
        reduceOnly: 'true'
      });

      const pnl = (entryPrice - closePrice) * qtyToClose;
      addLog(`>>> Đã đóng lệnh SHORT ${symbol} tại giá ${closePrice.toFixed(symbolInfo ? symbolInfo.pricePrecision : 8)}`);
      addLog(`>>> Lợi nhuận tạm tính: ${pnl.toFixed(2)} USDT`);
    } else {
      addLog('>>> Không có vị thế SHORT để đóng.');
    }
  } catch (error) {
    addLog('Lỗi khi đóng lệnh: ' + (error.msg || error.message));
  }
}

// Cron job chính để kiểm tra funding rates và mở lệnh
cron.schedule('*/1 * * * *', async () => {
  if (!botRunning) {
    addLog('[Cron] Bot đang tắt, không kiểm tra funding.');
    return;
  }
  addLog('>>> [Cron] Đã tới giờ hoàng đạo kiếm tiền uống bia, đang kiểm tra funding...');
  try {
    // Sử dụng callPublicAPI (đã gộp từ publicRequest của test.js)
    const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
    const fundingRates = allFundingData.map(item => ({
      symbol: item.symbol,
      fundingRate: item.lastFundingRate,
      fundingTime: item.nextFundingTime
    }));
    addLog(`>>> Đã lấy ${fundingRates.length} coin từ API Binance`);

    const candidates = [];

    await getExchangeInfo(); 

    for (const r of fundingRates) {
        if (parseFloat(r.fundingRate) < -0.0001) {
            // Sử dụng getLeverageBracketForSymbol (đã gộp từ test.js)
            const maxLeverageForCandidate = await getLeverageBracketForSymbol(r.symbol); 
            
            if (maxLeverageForCandidate) {
                addLog(`[DEBUG] ${r.symbol}: Funding Rate = ${r.fundingRate}, Max Leverage = ${maxLeverageForCandidate}x`);
            }

            if (typeof maxLeverageForCandidate === 'number' && maxLeverageForCandidate > 1) {
                // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js)
                const account = await callSignedAPI('/fapi/v2/account', 'GET');
                const usdtAsset = account.assets.find(a => a.asset === 'USDT');
                const balance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
                
                const currentPrice = await getCurrentPrice(r.symbol);
                if (!currentPrice) {
                    addLog(`[DEBUG] Bỏ qua ${r.symbol}: Không lấy được giá hiện tại để ước tính vốn.`);
                    continue;
                }
                const estimatedCapital = (balance * 0.8).toFixed(2);

                candidates.push({
                    ...r,
                    maxLeverage: maxLeverageForCandidate,
                    estimatedCapital: estimatedCapital,
                    currentPrice: currentPrice
                });
            } else {
                addLog(`[DEBUG] Bỏ qua ${r.symbol} vì không tìm thấy đòn bẩy hợp lệ (${maxLeverageForCandidate ? maxLeverageForCandidate : 'N/A'}x hoặc không phải số).`);
            }
        }
    }
    candidates.sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

    if (candidates.length > 0) {
      const best = candidates[0];
      selectedSymbol = best.symbol;
      // Trong test.js, timestamp được lấy không có serverTimeOffset.
      // Do đó, logic waitTime cũng sẽ chỉ dựa trên thời gian cục bộ.
      const waitTime = best.fundingTime + 500 - (Date.now()); 

      const projectedOpenTime = new Date(Date.now() + waitTime);
      const formattedProjectedOpenTime = `${projectedOpenTime.toLocaleDateString('en-GB')} ${projectedOpenTime.toLocaleTimeString('en-US', { hour12: false })}.${String(projectedOpenTime.getMilliseconds()).padStart(3, '0')}`;

      addLog(`>>> Đã chọn được đồng coin: ${selectedSymbol}`);
      addLog(`>>> Dự kiến lệnh mở lúc: ${formattedProjectedOpenTime}`);
      addLog(`>>> Funding rate: ${best.fundingRate}`);
      addLog(`>>> Đòn bẩy tối đa: ${best.maxLeverage}x`);
      addLog(`>>> Số tiền USDT vào lệnh (ước tính): ${best.estimatedCapital} USDT`);
      addLog(`>>> Giá hiện tại của ${selectedSymbol}: ${best.currentPrice}`);

      if (waitTime > 0) {
        addLog(`- Lệnh sẽ được mở sau ${(waitTime / 1000).toFixed(1)} giây.`);
        await delay(waitTime);
      } else {
         addLog(`- Đã qua thời điểm funding cho ${selectedSymbol}. Tiến hành mở lệnh ngay.`);
      }

      addLog('>>> Delay 500ms sau funding để chắc chắn nhận funding');
      await delay(500);
      
      await placeShortOrder(selectedSymbol, best.fundingRate, best.fundingTime);
    } else {
      addLog('>>> Không có coin có funding rate đủ tốt hoặc không hỗ trợ đòn bẩy để mở lệnh. Đi uống bia');
    }
  } catch (error) {
    addLog('Lỗi cron job: ' + (error.msg || error.message));
  }
});

// Thêm một đoạn code nhỏ để kiểm tra API ngay khi khởi động
(async () => {
  addLog('>>> [Khởi động] Đang kiểm tra API Key với Binance...');
  try {
    // Sử dụng callSignedAPI (đã gộp từ signedRequest của test.js)
    const account = await callSignedAPI('/fapi/v2/account', 'GET');
    addLog('✅ [Khởi động] API Key hoạt động bình thường! Balance: ' + account.assets.find(a => a.asset === 'USDT')?.availableBalance);
  } catch (error) {
    addLog('❌ [Khởi động] API Key không hoạt động hoặc có lỗi: ' + (error.msg || error.message));
    addLog('   -> Nếu lỗi là "-2014 API-key format invalid.", hãy kiểm tra lại API Key/Secret của bạn (chữ hoa/thường, khoảng trắng) hoặc giới hạn IP trên Binance.');
    addLog('   -> **QUAN TRỌNG**: Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", điều này có nghĩa đồng hồ trên máy chủ của bạn không chính xác. Bạn cần đồng bộ thời gian bằng cách chạy lệnh `sudo ntpdate pool.ntp.org` và `sudo timedatectl set-timezone UTC` trên VPS. Đây là vấn đề phổ biến nhất khi code `test.js` hoạt động nhưng bot không.');
    addLog('   -> Nếu lỗi liên quan đến giới hạn IP, hãy thêm IP của VPS của bạn vào danh sách trắng trên Binance.');
  }
})();
