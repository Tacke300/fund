import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Để thay thế __dirname trong ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === API KEY & SECRET ===
// !!! QUAN TRỌNG: ĐẢM BẢO ĐÂY LÀ API KEY VÀ SECRET KEY THẬT CỦA BẠN !!!
// Đã thêm .trim() để loại bỏ bất kỳ khoảng trắng thừa nào.
// Bạn phải DÁN API Key và Secret Key THẬT của mình vào đây
// KHÔNG ĐỂ NGUYÊN CHỮ 'API_KEY_CUA_BAN_VAO_DAY'
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); // DÁN API KEY CỦA BẠN VÀO ĐÂY
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fccDf0pEnFzoTc'.trim(); // DÁN SECRET KEY CỦA BẠN VÀO ĐÂY

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Giữ nguyên để tương thích

// Biến cache cho exchangeInfo
let exchangeInfoCache = null;

// Hàm addLog để ghi nhật ký, giữ nguyên từ bot
function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const logEntry = `[${time}] ${message}`;
    console.log(logEntry);
}

const delay = ms => new Promise(resolve => setTimeout(ms));

// Hàm tạo chữ ký HMAC SHA256 (từ test.js gốc của bạn)
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                 .update(queryString)
                 .digest('hex');
}

// Hàm gửi HTTP request (từ test.js gốc của bạn)
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

// Hàm gọi API có chữ ký (từ test.js gốc của bạn, đổi tên thành callSignedAPI)
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const recvWindow = 5000;
    const timestamp = Date.now();

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    addLog(`[DEBUG] Query String before signature: ${queryString}`);
    const signature = createSignature(queryString, SECRET_KEY);
    addLog(`[DEBUG] Generated Signature: ${signature}`);

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
        addLog(`[DEBUG] Request Method: ${method}, Path: ${requestPath}`);
        if (method === 'POST') {
            addLog(`[DEBUG] Request Body (for POST): ${requestBody}`);
        }
        addLog(`[DEBUG] Request Headers: ${JSON.stringify(headers)}`);

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

// Hàm gọi API công khai (từ test.js gốc của bạn, đổi tên thành callPublicAPI)
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

// Hàm lấy thời gian server Binance (từ bot_binance.js)
async function syncServerTime() {
  try {
    const data = await callPublicAPI('/fapi/v1/time');
    const binanceServerTime = data.serverTime;
    const localTime = Date.now();
    serverTimeOffset = binanceServerTime - localTime;
    addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms.`);
  } catch (error) {
    addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}.`);
    serverTimeOffset = 0;
  }
}

// HÀM ĐÃ ĐƯỢC SỬA: Hàm lấy thông tin đòn bẩy cho một symbol (từ bot_binance.js)
async function getLeverageBracketForSymbol(symbol) {
    try {
        addLog(`[DEBUG getLeverageBracketForSymbol] Đang cố gắng lấy leverageBracket cho ${symbol}...`);
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });

        if (response && Array.isArray(response) && response.length > 0) {
            // Tìm symbol phù hợp trong mảng response (nếu có nhiều symbol trong một request)
            const symbolData = response.find(item => item.symbol === symbol);

            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                const firstBracket = symbolData.brackets[0];
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
        }
        addLog(`[DEBUG getLeverageBracketForSymbol] Không tìm thấy thông tin đòn bẩy hợp lệ cho ${symbol} từ response.`);
        return null;
    } catch (error) {
        addLog(`❌ Lỗi khi lấy getLeverageBracketForSymbol cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Hàm lấy thông tin sàn (từ bot_binance.js)
async function getExchangeInfo() {
  if (exchangeInfoCache) {
    addLog('>>> Đã có cache exchangeInfo. Trả về cache.');
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

// Hàm kết hợp để lấy tất cả filters và maxLeverage (từ bot_binance.js)
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

// Hàm lấy giá hiện tại (từ bot_binance.js)
async function getCurrentPrice(symbol) {
  try {
    const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
    const price = parseFloat(data.price);
    return price;
  } catch (error) {
    addLog(`Lỗi khi lấy giá cho ${symbol}: ` + (error.msg || error.message));
    return null;
  }
}

// Hàm đóng lệnh Short (từ bot_binance.js)
async function closeShortPosition(symbol, qtyToClose = null) {
  try {
    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol}`);
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


// Hàm mở lệnh Short (từ bot_binance.js)
async function placeShortOrder(symbol, currentFundingRate, bestFundingTime) {
  try {
    // Lấy số dư hiện tại của bạn
    addLog('>>> Đang kiểm tra số dư khả dụng...');
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
    await callSignedAPI('/fapi/v1/leverage', 'POST', {
      symbol: symbol,
      leverage: maxLeverage
    });
    addLog(`Đã đặt đòn bòn ${maxLeverage}x cho ${symbol}.`);

    const capital = balance * 0.8; // 80% vốn
    let quantity = (capital * maxLeverage) / price;

    const minQty = symbolInfo.minQty;
    const maxQty = symbolInfo.maxQty;
    const stepSize = symbolInfo.stepSize;
    const minNotional = symbolInfo.minNotional;
    const quantityPrecision = symbolInfo.quantityPrecision;

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
    const order = await callSignedAPI('/fapi/v1/order', 'POST', {
      symbol: symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity
    });

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
        // Để tránh lỗi lặp lại vô hạn nếu có lỗi API trong watcher
        clearInterval(checkInterval);
      }
    }, 1000);
  } catch (error) {
    addLog('Lỗi mở lệnh short: ' + (error.msg || error.message));
  }
}

// === Logic chính để chạy thử ===
(async () => {
    addLog('>>> [Khởi động] Đang kiểm tra API Key với Binance...');
    try {
        await syncServerTime(); // Đồng bộ thời gian
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        addLog('✅ [Khởi động] API Key hoạt động bình thường! Balance: ' + account.assets.find(a => a.asset === 'USDT')?.availableBalance);

        // Lấy danh sách funding rates để chọn symbol
        addLog('>>> [Khởi động] Đang tìm kiếm symbol có funding rate thấp nhất...');
        const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
        const fundingRates = allFundingData.map(item => ({
            symbol: item.symbol,
            fundingRate: item.lastFundingRate,
            fundingTime: item.nextFundingTime
        }));

        const candidates = [];
        await getExchangeInfo(); // Đảm bảo exchangeInfo được tải

        for (const r of fundingRates) {
            // Lọc các coin có funding rate âm (cho lệnh SHORT)
            if (parseFloat(r.fundingRate) < -0.0001) {
                // Kiểm tra xem symbol có trong exchangeInfoCache không
                if (exchangeInfoCache && exchangeInfoCache[r.symbol]) {
                    const maxLeverageForCandidate = await getLeverageBracketForSymbol(r.symbol);
                    if (typeof maxLeverageForCandidate === 'number' && maxLeverageForCandidate > 1) {
                        candidates.push({
                            ...r,
                            maxLeverage: maxLeverageForCandidate
                        });
                    }
                } else {
                    addLog(`[DEBUG] Bỏ qua symbol ${r.symbol} vì không tìm thấy trong exchangeInfo hoặc không có thông tin lọc.`);
                }
            }
        }
        candidates.sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

        if (candidates.length > 0) {
            const best = candidates[0];
            const selectedSymbol = best.symbol;
            addLog(`>>> [Khởi động] Đã chọn được đồng coin: ${selectedSymbol} với Funding Rate: ${best.fundingRate} và Max Leverage: ${best.maxLeverage}`);

            // Thử mở lệnh short với symbol đã chọn
            await placeShortOrder(selectedSymbol, best.fundingRate, best.fundingTime);
        } else {
            addLog('>>> [Khởi động] Không có coin có funding rate đủ tốt hoặc không hỗ trợ đòn bẩy để mở lệnh.');
        }

    } catch (error) {
        addLog('❌ [Khởi động] Đã xảy ra lỗi: ' + (error.msg || error.message));
        addLog('   -> Nếu lỗi là "-2014 API-key format invalid.", hãy kiểm tra lại API Key/Secret của bạn (chữ hoa/thường, khoảng trắng) hoặc giới hạn IP trên Binance.');
        addLog('   -> **QUAN TRỌNG**: Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", điều này có nghĩa đồng hồ trên máy chủ của bạn không chính xác. Bạn cần đồng bộ thời gian bằng cách chạy lệnh `sudo ntpdate pool.ntp.org` và `sudo timedatectl set-timezone UTC` trên VPS.');
        addLog('   -> Nếu lỗi liên quan đến giới hạn IP, hãy thêm IP của VPS của bạn vào danh sách trắng trên Binance.');
    }
})();

