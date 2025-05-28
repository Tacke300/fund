/***************** CẤU HÌNH CHUNG  *****************/
const express = require('express');
const https = require('https'); // Cần thiết cho các request thủ công
const crypto = require('crypto'); // Cần thiết cho việc tạo signature thủ công
const fetch = require('node-fetch'); // Cần thiết cho các request không ký (premiumIndex, exchangeInfo)
const path = require('path');
const cron = require('node-cron');

const app = express();
const port = 3000;

// === API KEY & SECRET ===
const apiKey = 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A';
const apiSecret = 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm';

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_URL = 'fapi.binance.com';

// Biến lưu trữ lệch thời gian với server Binance
let serverTimeOffset = 0; // Sẽ được tính toán sau

/***************** HÀM TIỆN ÍCH CHUNG *****************/
let logs = [];
let botRunning = false;
let selectedSymbol = null;
let leverageCache = null; // Cache cho maxLeverage và stepSize

function addLog(message) {
  const time = new Date().toLocaleString();
  const logEntry = `[${time}] ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 1000) logs.shift(); // Giới hạn số lượng log
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/***************** HÀM KÝ & GỌI API THỦ CÔNG (Được nhúng vào) *****************/
function getSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Hàm để lấy thời gian server Binance và tính toán độ lệch.
 * Nên chạy hàm này một lần khi khởi động bot, và có thể chạy lại định kỳ (ví dụ: mỗi giờ).
 */
async function syncServerTime() {
  try {
    const response = await fetch(`https://${BASE_URL}/fapi/v1/time`);
    if (!response.ok) {
      throw new Error(`Failed to fetch Binance server time: ${response.statusText}`);
    }
    const data = await response.json();
    const binanceServerTime = data.serverTime;
    const localTime = Date.now();
    serverTimeOffset = binanceServerTime - localTime; // serverTime - localTime = offset
    addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms.`);
  } catch (error) {
    addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}. Sử dụng thời gian cục bộ.`);
    serverTimeOffset = 0; // Reset offset nếu có lỗi
  }
}

/**
 * Hàm chung để gọi API có ký của Binance Futures (thủ công).
 * @param {string} endpoint - Phần cuối của URL API (ví dụ: '/fapi/v2/account').
 * @param {string} method - Phương thức HTTP (GET, POST, PUT, DELETE). Mặc định là 'GET'.
 * @param {Object} params - Các tham số query dưới dạng object.
 * @returns {Promise<Object>} Dữ liệu JSON trả về từ API.
 */
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
  const timestamp = Date.now() + serverTimeOffset; // Sử dụng timestamp đã đồng bộ
  const recvWindow = 60000; // Có thể tăng nếu mạng latency cao

  // === Bước 1: Chuẩn bị tham số cho việc tạo Signature (chuyển thành String, KHÔNG URL-encode) ===
  const allParamsForSignature = {
    timestamp: String(timestamp),
    recvWindow: String(recvWindow),
    ...params // Giả định các giá trị trong params đã là số hoặc chuỗi hợp lệ
  };

  // Sắp xếp các khóa theo thứ tự bảng chữ cái để tạo chuỗi ký
  const sortedKeysForSignature = Object.keys(allParamsForSignature).sort();

  // Tạo chuỗi truy vấn (query string) cho việc tạo chữ ký
  // CÁC GIÁ TRỊ KHÔNG ĐƯỢC URL-ENCODE TẠI BƯỚC NÀY
  const queryStringForSignature = sortedKeysForSignature
    .map(key => `${key}=${allParamsForSignature[key]}`)
    .join('&');

  const signature = getSignature(queryStringForSignature, apiSecret);

  // === Bước 2: Chuẩn bị tham số cho URL Request (URL-encode các giá trị) ===
  // Tạo chuỗi truy vấn (query string) cho URL thực tế, CÁC GIÁ TRỊ CẦN ĐƯỢC URL-ENCODE
  const queryStringForUrl = sortedKeysForSignature
    .map(key => `${key}=${encodeURIComponent(allParamsForSignature[key])}`)
    .join('&');

  // Xây dựng đường dẫn đầy đủ với signature
  const fullPath = `${endpoint}?${queryStringForUrl}&signature=${signature}`;

  // DEBUG LOGS ĐÃ CẬP NHẬT để hiển thị rõ các chuỗi
  console.log('\n--- DEBUG API CALL ---');
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Method: ${method}`);
  console.log(`Initial Params: ${JSON.stringify(params)}`);
  console.log(`All Params for Signature (string values): ${JSON.stringify(allParamsForSignature)}`);
  console.log(`Calculated Timestamp (local + offset): ${timestamp}`);
  console.log(`Query String for Signature (SIGNED): ${queryStringForSignature}`); // Chuỗi dùng để ký
  console.log(`Generated Signature: ${signature}`);
  console.log(`Query String for URL (URL-ENCODED): ${queryStringForUrl}`); // Chuỗi gửi trong URL
  console.log(`Full Path (sent to Binance): https://${BASE_URL}${fullPath}`);
  console.log('--- END DEBUG API CALL ---\n');

  const options = {
    hostname: BASE_URL,
    path: fullPath,
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      // 'Content-Type': 'application/json' // Không cần thiết nếu không gửi body JSON
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Lỗi parse JSON từ ${endpoint}: ${body}. Chi tiết: ${e.message}`));
          }
        } else {
          let errorMsg = body;
          try {
            const errorJson = JSON.parse(body);
            if (errorJson && errorJson.code && errorJson.msg) {
              errorMsg = `Code: ${errorJson.code}, Msg: ${errorJson.msg}`;
            }
          } catch (parseError) {
            // Không thể parse JSON, giữ nguyên body
          }
          reject(new Error(`API lỗi ${endpoint}: ${res.statusCode} - ${errorMsg}`));
        }
      });
    });
    req.on('error', err => reject(new Error(`Lỗi request đến ${endpoint}: ${err.message}`)));
    req.end();
  });
}

/***************** ROUTES HTTP  *****************/
app.use(express.json());
app.use('/bot', express.static(path.join(__dirname)));
app.get('/', (req, res) => res.send('Funding bot is running!'));

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> /balance được gọi');
    const account = await callSignedAPI('/fapi/v2/account');
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    res.json({ balance: usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0 });
  } catch (error) {
    addLog('Lỗi trong /balance: ' + error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/funding', async (req, res) => {
  try {
    const opts = { hostname: BASE_URL, path: '/fapi/v1/premiumIndex', method: 'GET' };
    const fundingRates = await new Promise((resolve, reject) => {
      const r = https.request(opts, rs => {
        let d = ''; rs.on('data', c => d += c);
        rs.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error('Lỗi parse JSON từ /fapi/v1/premiumIndex: ' + d)); }
        });
      });
      r.on('error', reject); r.end();
    });

    const simplified = fundingRates.map(item => ({
      symbol: item.symbol,
      fundingRate: parseFloat(item.lastFundingRate),
      time: new Date(parseInt(item.nextFundingTime)).toLocaleString()
    }));
    res.json(simplified);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
  await syncServerTime();
  cron.schedule('0 * * * *', async () => {
      addLog('[Cron] Đồng bộ lại thời gian server Binance.');
      await syncServerTime();
  });
});

/***************** HÀM LẤY THÔNG TIN SÀN  *****************/

async function getExchangeInfo() {
  if (leverageCache) {
    addLog('>>> Đã có cache exchangeInfo. Trả về cache.');
    return leverageCache;
  }

  addLog('>>> Đang lấy exchangeInfo từ Binance...');
  try {
    const url = `https://${BASE_URL}/fapi/v1/exchangeInfo`;
    addLog(`[DEBUG] Gọi ExchangeInfo URL: ${url}`);
    const res = await fetch(url);
    
    if (!res.ok) {
      const errorText = await res.text();
      addLog(`❌ Lỗi HTTP khi lấy exchangeInfo: ${res.status} - ${errorText}`);
      throw new Error(`Failed to get exchangeInfo: ${res.statusText}`);
    }
    
    const data = await res.json();
    addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`);
    
    leverageCache = {};
    data.symbols.forEach(s => {
      const levFilter = s.filters.find(f => f.filterType === 'LEVERAGE');
      const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
      const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
      const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

      leverageCache[s.symbol] = {
        maxLeverage: levFilter ? parseInt(levFilter.maxLeverage) : null,
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
        maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.maxQty) : Infinity),
        stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 0,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision
      };
    });
    addLog('>>> Đã tải thông tin sàn và cache thành công.');
    return leverageCache;
  } catch (error) {
    addLog('Lỗi khi lấy exchangeInfo: ' + error.message);
    leverageCache = null;
    return null;
  }
}

async function getMaxLeverageAndFilters(symbol) {
  const info = await getExchangeInfo();
  return info ? info[symbol] : null;
}

async function getCurrentPrice(symbol) {
  const response = await fetch(`https://${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  if (!response.ok) {
    throw new Error(`Failed to get price for ${symbol}: ${response.statusText}`);
  }
  const data = await response.json();
  const price = parseFloat(data.price);
  addLog(`>>> Giá hiện tại của ${symbol} là ${price}`);
  return price;
}

/***************** ĐẶT & ĐÓNG LỆNH  *****************/
async function placeShortOrder(symbol) {
  try {
    addLog(`>>> Bắt đầu mở lệnh SHORT cho ${symbol}`);
    // Đây là lệnh API có ký đầu tiên trong luồng này.
    const account = await callSignedAPI('/fapi/v2/account');
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    const balance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
    
    if (balance < 0.15) {
      addLog(`>>> Không đủ balance để mở lệnh. Balance hiện tại: ${balance}`);
      return;
    }

    const symbolFilters = await getMaxLeverageAndFilters(symbol);
    if (!symbolFilters || !symbolFilters.maxLeverage) {
      addLog(`>>> Không lấy được thông tin đòn bẩy hoặc bộ lọc cho ${symbol}, hủy mở lệnh.`);
      return;
    }

    const maxLeverage = symbolFilters.maxLeverage;
    const price = await getCurrentPrice(symbol);
    if (!price) {
        addLog(`Không thể lấy giá cho ${symbol}. Hủy mở lệnh.`);
        return;
    }

    // Đặt đòn bẩy
    addLog(`[DEBUG] Đang đặt đòn bẩy. symbol: ${symbol}, leverage: ${maxLeverage}`);
    await callSignedAPI('/fapi/v1/leverage', 'POST', {
      symbol: symbol,
      leverage: maxLeverage // leverage sẽ được chuyển thành string và encode trong callSignedAPI
    });
    addLog(`Đã đặt đòn bẩy ${maxLeverage}x cho ${symbol}.`);

    const capital = balance * 0.8;
    let quantity = (capital * maxLeverage) / price;

    const minQty = symbolFilters.minQty;
    const maxQty = symbolFilters.maxQty;
    const stepSize = symbolFilters.stepSize;
    const minNotional = symbolFilters.minNotional;
    const quantityPrecision = symbolFilters.quantityPrecision;

    quantity = Math.floor(quantity / stepSize) * stepSize;
    quantity = parseFloat(quantity.toFixed(quantityPrecision));
    quantity = Math.max(minQty, Math.min(maxQty, quantity));

    const currentNotional = quantity * price;
    if (currentNotional < minNotional) {
        addLog(`Giá trị notional (${currentNotional.toFixed(2)}) cho ${symbol} quá thấp. Cần tối thiểu ${minNotional} USDT. Hủy mở lệnh.`);
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
      quantity: quantity // quantity sẽ được chuyển thành string và encode trong callSignedAPI
    });

    addLog(`>>> Đã mở lệnh SHORT ${symbol}`);
    addLog(`- Khối lượng: ${quantity}`);
    addLog(`- Đòn bẩy: ${maxLeverage}`);
    addLog(`- Giá vào: ${price}`);
    addLog(`- Giá trị lệnh: ${(quantity * price).toFixed(2)} USDT`);

    const entryPrice = parseFloat(order.avgFillPrice || price);
    const tpSlValue = (maxLeverage / 100) * capital;
    const tpPrice = entryPrice - (tpSlValue / quantity);
    const slPrice = entryPrice + (tpSlValue / quantity);
    addLog(`>>> Giá TP: ${tpPrice.toFixed(symbolFilters.pricePrecision)}, Giá SL: ${slPrice.toFixed(symbolFilters.pricePrecision)}`);

    let checkCount = 0;
    const maxCheck = 180;

    const checkInterval = setInterval(async () => {
      if (!botRunning) {
        clearInterval(checkInterval);
        addLog(`Watcher cho ${symbol} dừng do bot đã tắt.`);
        return;
      }
      try {
        checkCount++;
        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice <= tpPrice) {
          addLog(`>>> Giá đạt TP: ${currentPrice.toFixed(symbolFilters.pricePrecision)}. Đóng lệnh ngay.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol, quantity);
        } else if (currentPrice >= slPrice) {
          addLog(`>>> Giá đạt SL: ${currentPrice.toFixed(symbolFilters.pricePrecision)}. Đóng lệnh ngay.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol, quantity);
        } else if (checkCount >= maxCheck) {
          addLog(`>>> Quá 3 phút chưa đạt TP/SL. Đóng lệnh.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol, quantity);
        }
      } catch (error) {
        addLog('Lỗi khi check TP/SL: ' + error.message);
      }
    }, 1000);
  } catch (error) {
    addLog('Lỗi mở lệnh short: ' + error.message);
  }
}

async function closeShortPosition(symbol, qtyToClose = null) {
  try {
    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol}`);
    const positions = await callSignedAPI('/fapi/v2/positionRisk');
    const position = positions.find(p => p.symbol === symbol);

    if (position && parseFloat(position.positionAmt) !== 0) {
      const currentPositionQty = Math.abs(parseFloat(position.positionAmt));
      if (qtyToClose === null || qtyToClose > currentPositionQty) {
        qtyToClose = currentPositionQty;
      }

      const closePrice = await getCurrentPrice(symbol);
      const entryPrice = parseFloat(position.entryPrice);
      const symbolFilters = await getMaxLeverageAndFilters(symbol);
      const quantityPrecision = symbolFilters ? symbolFilters.quantityPrecision : 3;

      qtyToClose = parseFloat(qtyToClose.toFixed(quantityPrecision));

      addLog(`[DEBUG] Đang đóng lệnh SHORT. symbol: ${symbol}, quantity: ${qtyToClose}`);
      await callSignedAPI('/fapi/v1/order', 'POST', {
        symbol: symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: qtyToClose, // qtyToClose sẽ được chuyển thành string và encode trong callSignedAPI
        reduceOnly: 'true'
      });

      const pnl = (entryPrice - closePrice) * qtyToClose;
      addLog(`>>> Đã đóng lệnh SHORT ${symbol} tại giá ${closePrice.toFixed(symbolFilters.pricePrecision)}`);
      addLog(`>>> Lợi nhuận tạm tính: ${pnl.toFixed(2)} USDT`);
    } else {
      addLog('>>> Không có vị thế SHORT để đóng.');
    }
  } catch (error) {
    addLog('Lỗi khi đóng lệnh: ' + error.message);
  }
}

// Đây là hàm getFundingRatesFromBinance mà bạn đã gọi trong cron job
// Đã được thêm vào để code hoàn chỉnh hơn, nếu bạn chưa có.
async function getFundingRatesFromBinance() {
  try {
    const opts = { hostname: BASE_URL, path: '/fapi/v1/premiumIndex', method: 'GET' };
    const fundingRates = await new Promise((resolve, reject) => {
      const r = https.request(opts, rs => {
        let d = ''; rs.on('data', c => d += c);
        rs.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error('Lỗi parse JSON từ /fapi/v1/premiumIndex: ' + d)); }
        });
      });
      r.on('error', reject); r.end();
    });
    return fundingRates;
  } catch (error) {
    addLog('Lỗi khi lấy funding rates từ Binance: ' + error.message);
    throw error; // Re-throw để cron job catch được
  }
}

cron.schedule('*/1 * * * *', async () => {
  if (!botRunning) {
    addLog('[Cron] Bot đang tắt, không kiểm tra funding.');
    return;
  }
  addLog('>>> [Cron] Đã tới giờ hoàng đạo kiếm tiền uống bia, đang kiểm tra funding...');
  try {
    const allFundingData = await getFundingRatesFromBinance(); // Đảm bảo hàm này tồn tại
    const fundingRates = allFundingData.map(item => ({
      symbol: item.symbol,
      fundingRate: item.lastFundingRate,
      fundingTime: item.nextFundingTime
    }));
    addLog(`>>> Đã lấy ${fundingRates.length} coin từ API Binance`);

    const negativeRates = fundingRates
      .filter(r => parseFloat(r.fundingRate) < -0.0001)
      .sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

    if (negativeRates.length > 0) {
      const best = negativeRates[0];
      selectedSymbol = best.symbol;
      const waitTime = best.fundingTime + 500 - (Date.now() + serverTimeOffset);

      addLog(`>>> Chọn được coin: ${selectedSymbol} | Funding rate: ${best.fundingRate}`);
      if (waitTime > 0) {
        addLog(`- Sẽ mở lệnh sau ${(waitTime / 1000).toFixed(1)} giây`);
        await delay(waitTime);
      } else {
         addLog(`- Đã qua thời điểm funding cho ${selectedSymbol}. Tiến hành mở lệnh ngay.`);
      }

      addLog('>>> Delay 500ms sau funding để chắc chắn nhận funding');
      await delay(500);
      await placeShortOrder(selectedSymbol);
    } else {
      addLog('>>> Không có coin sắp tới mở lệnh đâu. Đi uống bia');
    }
  } catch (error) {
    addLog('Lỗi cron job: ' + error.message);
  }
});
