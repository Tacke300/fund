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

  const allParams = {
    timestamp,
    recvWindow,
    ...params
  };

  // Sắp xếp tham số theo thứ tự bảng chữ cái (quan trọng cho signature)
  const sortedKeys = Object.keys(allParams).sort();
  const queryString = sortedKeys
    .map(key => `${key}=${allParams[key]}`)
    .join('&');

  const signature = getSignature(queryString, apiSecret);
  const fullPath = `${endpoint}?${queryString}&signature=${signature}`;

  // DEBUG LOGS (Đã có ở các phiên bản trước, giữ lại để kiểm tra)
  console.log('\n--- DEBUG API CALL ---');
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Method: ${method}`);
  console.log(`Initial Params: ${JSON.stringify(params)}`);
  console.log(`All Params (with timestamp, recvWindow): ${JSON.stringify(allParams)}`);
  console.log(`Calculated Timestamp (local + offset): ${timestamp}`);
  console.log(`Sorted Query String (for signature): ${queryString}`);
  console.log(`Generated Signature: ${signature}`);
  console.log(`Full Path (sent to Binance): https://${BASE_URL}${fullPath}`);
  console.log('--- END DEBUG API CALL ---\n');

  const options = {
    hostname: BASE_URL,
    path: fullPath,
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/json' // Đảm bảo header phù hợp
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
          // Cải thiện thông báo lỗi để hiển thị mã lỗi và tin nhắn từ Binance
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
    // Thay thế binance.futuresAccount() bằng callSignedAPI thủ công
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
    // Đây là public endpoint, không cần ký, giữ nguyên cách gọi fetch/https.request
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
      fundingRate: parseFloat(item.lastFundingRate), // Đảm bảo là số
      time: new Date(parseInt(item.nextFundingTime)).toLocaleString() // Đảm bảo là số nguyên
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
  await syncServerTime(); // Đồng bộ thời gian khi server khởi động
  // Có thể thêm cron job để đồng bộ lại thời gian định kỳ
  cron.schedule('0 * * * *', async () => { // Đồng bộ mỗi giờ
      addLog('[Cron] Đồng bộ lại thời gian server Binance.');
      await syncServerTime();
  });
});

/***************** HÀM LẤY THÔNG TIN SÀN  *****************/

async function getExchangeInfo() {
  if (leverageCache) return leverageCache; // Trả về cache nếu đã có

  try {
    const res = await fetch(`https://${BASE_URL}/fapi/v1/exchangeInfo`);
    if (!res.ok) throw new Error(`Failed to get exchangeInfo: ${res.statusText}`);
    const data = await res.json();
    
    leverageCache = {}; // Khởi tạo cache
    data.symbols.forEach(s => {
      const levFilter = s.filters.find(f => f.filterType === 'LEVERAGE');
      const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
      const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
      const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

      leverageCache[s.symbol] = {
        maxLeverage: levFilter ? parseInt(levFilter.maxLeverage) : null,
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
        maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.maxQty) : Infinity),
        stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001), // Default stepSize
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 0,
        pricePrecision: s.pricePrecision, // Thêm pricePrecision để làm tròn giá
        quantityPrecision: s.quantityPrecision // Thêm quantityPrecision để làm tròn số lượng
      };
    });
    addLog('>>> Đã tải thông tin sàn và cache.');
    return leverageCache;
  } catch (error) {
    addLog('Lỗi khi lấy exchangeInfo: ' + error.message);
    leverageCache = null; // Đặt lại cache nếu có lỗi
    return null;
  }
}

async function getMaxLeverageAndFilters(symbol) {
  const info = await getExchangeInfo();
  return info ? info[symbol] : null;
}

async function getCurrentPrice(symbol) {
  // Binance có endpoint public cho giá ticker
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
    // Lấy thông tin tài khoản qua hàm thủ công
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
    // Thay thế binance.futuresLeverage bằng callSignedAPI thủ công
    await callSignedAPI('/fapi/v1/leverage', 'POST', {
      symbol: symbol,
      leverage: maxLeverage
    });
    addLog(`Đã đặt đòn bẩy ${maxLeverage}x cho ${symbol}.`);

    const capital = balance * 0.8;
    let quantity = (capital * maxLeverage) / price;

    // Áp dụng các bộ lọc LOT_SIZE và MIN_NOTIONAL
    const minQty = symbolFilters.minQty;
    const maxQty = symbolFilters.maxQty;
    const stepSize = symbolFilters.stepSize;
    const minNotional = symbolFilters.minNotional;
    const quantityPrecision = symbolFilters.quantityPrecision; // Dùng quantityPrecision để làm tròn chính xác

    // Làm tròn quantity theo stepSize và precision
    quantity = Math.floor(quantity / stepSize) * stepSize;
    // Đảm bảo làm tròn số lượng đến số chữ số thập phân cho phép
    quantity = parseFloat(quantity.toFixed(quantityPrecision));

    // Kiểm tra min/max quantity
    quantity = Math.max(minQty, Math.min(maxQty, quantity));

    // Kiểm tra MIN_NOTIONAL
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
    // Thay thế binance.futuresMarketSell bằng callSignedAPI thủ công
    const order = await callSignedAPI('/fapi/v1/order', 'POST', {
      symbol: symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: quantity
    });

    addLog(`>>> Đã mở lệnh SHORT ${symbol}`);
    addLog(`- Khối lượng: ${quantity}`); // Không cần toFixed(3) ở đây, đã làm tròn chính xác
    addLog(`- Đòn bẩy: ${maxLeverage}`);
    addLog(`- Giá vào: ${price}`);
    addLog(`- Giá trị lệnh: ${(quantity * price).toFixed(2)} USDT`);

    const entryPrice = parseFloat(order.avgFillPrice || price);
    // Logic TP/SL này có vẻ đơn giản, cần xem xét lại tỷ lệ rủi ro/lợi nhuận bạn muốn
    const tpSlValue = (maxLeverage / 100) * capital; // Logic này chưa chắc đã đúng cho TP/SL
    const tpPrice = entryPrice - (tpSlValue / quantity);
    const slPrice = entryPrice + (tpSlValue / quantity);
    addLog(`>>> Giá TP: ${tpPrice.toFixed(symbolFilters.pricePrecision)}, Giá SL: ${slPrice.toFixed(symbolFilters.pricePrecision)}`);

    let checkCount = 0;
    const maxCheck = 180; // 3 phút

    const checkInterval = setInterval(async () => {
      if (!botRunning) { // Dừng watcher nếu bot bị tắt
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
          await closeShortPosition(symbol, quantity); // Truyền quantity để đóng lệnh
        } else if (currentPrice >= slPrice) {
          addLog(`>>> Giá đạt SL: ${currentPrice.toFixed(symbolFilters.pricePrecision)}. Đóng lệnh ngay.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol, quantity); // Truyền quantity để đóng lệnh
        } else if (checkCount >= maxCheck) {
          addLog(`>>> Quá 3 phút chưa đạt TP/SL. Đóng lệnh.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol, quantity); // Truyền quantity để đóng lệnh
        }
      } catch (error) {
        addLog('Lỗi khi check TP/SL: ' + error.message);
      }
    }, 1000);
  } catch (error) {
    addLog('Lỗi mở lệnh short: ' + error.message);
  }
}

// Cần truyền quantity vào hàm closeShortPosition
async function closeShortPosition(symbol, qtyToClose = null) {
  try {
    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol}`);
    // Lấy vị thế qua hàm thủ công
    const positions = await callSignedAPI('/fapi/v2/positionRisk'); // Dùng positionRisk để lấy vị thế hiện tại
    const position = positions.find(p => p.symbol === symbol);

    if (position && parseFloat(position.positionAmt) !== 0) {
      const currentPositionQty = Math.abs(parseFloat(position.positionAmt));
      if (qtyToClose === null || qtyToClose > currentPositionQty) { // Nếu không truyền qtyToClose hoặc qty truyền vào lớn hơn vị thế hiện tại, đóng toàn bộ
        qtyToClose = currentPositionQty;
      }

      const closePrice = await getCurrentPrice(symbol);
      const entryPrice = parseFloat(position.entryPrice);
      const symbolFilters = await getMaxLeverageAndFilters(symbol);
      const quantityPrecision = symbolFilters ? symbolFilters.quantityPrecision : 3; // Default 3 nếu không lấy được filter

      // Đảm bảo qtyToClose cũng được làm tròn theo precision
      qtyToClose = parseFloat(qtyToClose.toFixed(quantityPrecision));

      // Đặt lệnh BUY MARKET để đóng vị thế SHORT
      // Thay thế binance.futuresMarketBuy bằng callSignedAPI thủ công
      await callSignedAPI('/fapi/v1/order', 'POST', {
        symbol: symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: qtyToClose,
        reduceOnly: 'true' // RẤT QUAN TRỌNG: Đảm bảo đây là lệnh đóng vị thế
      });

      const pnl = (entryPrice - closePrice) * qtyToClose; // PnL cho lệnh Short
      addLog(`>>> Đã đóng lệnh SHORT ${symbol} tại giá ${closePrice.toFixed(symbolFilters.pricePrecision)}`);
      addLog(`>>> Lợi nhuận tạm tính: ${pnl.toFixed(2)} USDT`);
    } else {
      addLog('>>> Không có vị thế SHORT để đóng.');
    }
  } catch (error) {
    addLog('Lỗi khi đóng lệnh: ' + error.message);
  }
}


cron.schedule('*/1 * * * *', async () => {
  if (!botRunning) {
    addLog('[Cron] Bot đang tắt, không kiểm tra funding.');
    return;
  }
  addLog('>>> [Cron] Đã tới giờ hoàng đạo kiếm tiền uống bia, đang kiểm tra funding...');
  try {
    // getFundingRatesFromBinance() đã sử dụng https.request, không cần thay đổi
    const allFundingData = await getFundingRatesFromBinance();
    const fundingRates = allFundingData.map(item => ({
      symbol: item.symbol,
      fundingRate: item.lastFundingRate,
      fundingTime: item.nextFundingTime
    }));
    addLog(`>>> Đã lấy ${fundingRates.length} coin từ API Binance`);
    // Logs có thể quá nhiều nếu có hàng trăm coin
    // fundingRates.forEach(rate => addLog(`Funding | ${rate.symbol}: ${rate.fundingRate}`));

    const negativeRates = fundingRates
      .filter(r => parseFloat(r.fundingRate) < -0.0001)
      .sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

    if (negativeRates.length > 0) {
      const best = negativeRates[0];
      selectedSymbol = best.symbol;
      // Tính toán thời gian chờ dựa trên timestamp đã đồng bộ
      const waitTime = best.fundingTime + 500 - (Date.now() + serverTimeOffset);

      addLog(`>>> Chọn được coin: ${selectedSymbol} | Funding rate: ${best.fundingRate}`);
      if (waitTime > 0) {
        addLog(`- Sẽ mở lệnh sau ${(waitTime / 1000).toFixed(1)} giây`);
        await delay(waitTime);
      } else {
         addLog(`- Đã qua thời điểm funding cho ${selectedSymbol}. Tiến hành mở lệnh ngay.`);
      }

      addLog('>>> Delay 500ms sau funding để chắc chắn nhận funding');
      await delay(500); // Thêm một delay nhỏ sau khi chờ
      await placeShortOrder(selectedSymbol);
    } else {
      addLog('>>> Không có coin sắp tới mở lệnh đâu. Đi uống bia');
    }
  } catch (error) {
    addLog('Lỗi cron job: ' + error.message);
  }
});
