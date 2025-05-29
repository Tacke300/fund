/***************** CẤU HÌNH CHUNG  *****************/
import express from 'express';
import https from 'https';
import crypto from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import cron from 'node-cron';

// Để thay thế __dirname trong ES Modules
import { fileURLToPath } = from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

// === API KEY & SECRET ===
// GIỮ NGUYÊN API KEY VÀ SECRET CỦA BẠN NHƯ BẠN ĐÃ CUNG CẤP.
// Đã thêm .trim() để đảm bảo không có khoảng trắng thừa, dù bạn đã kiểm tra kỹ.
const apiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); // Your API Key
const apiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // Your API Secret

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_URL = 'fapi.binance.com';

// Biến lưu trữ lệch thời gian với server Binance
let serverTimeOffset = 0; // Sẽ được tính toán sau

/***************** HÀM TIỆN ÍCH CHUNG *****************/
let logs = [];
let botRunning = false;
let selectedSymbol = null;
// exchangeInfoCache giờ sẽ chỉ lưu minQty, maxQty, stepSize, minNotional, pricePrecision, quantityPrecision
// MaxLeverage sẽ được lấy riêng từ API leverageBracket
let exchangeInfoCache = null;

function addLog(message) {
  const now = new Date();
  const time = `${now.toLocaleDateString()} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  const logEntry = `[${time}] ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 1000) logs.shift(); // Giới hạn số lượng log
}

const delay = ms => new Promise(resolve => setTimeout(ms));

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
  // Đảm bảo timestamp được tạo ngay trước khi gửi request
  const timestamp = Date.now() + serverTimeOffset; 
  const recvWindow = 60000; // Có thể tăng nếu mạng latency cao, thử 5000 hoặc 10000 trước khi lên 60000

  const allParamsForSignature = {
    timestamp: String(timestamp),
    recvWindow: String(recvWindow),
    ...params
  };

  const sortedKeysForSignature = Object.keys(allParamsForSignature).sort();

  const queryStringForSignature = sortedKeysForSignature
    .map(key => `${key}=${allParamsForSignature[key]}`)
    .join('&');

  const signature = getSignature(queryStringForSignature, apiSecret);

  // Debug log để kiểm tra chuỗi ký và chữ ký
  addLog(`[DEBUG SIGNATURE] Endpoint: ${endpoint}`);
  addLog(`[DEBUG SIGNATURE] Query String for Signature: ${queryStringForSignature}`);
  addLog(`[DEBUG SIGNATURE] Generated Signature: ${signature}`);


  const queryStringForUrl = sortedKeysForSignature
    .map(key => `${key}=${encodeURIComponent(allParamsForSignature[key])}`)
    .join('&');

  const fullPath = `${endpoint}?${queryStringForUrl}&signature=${signature}`;

  const options = {
    hostname: BASE_URL,
    path: fullPath,
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'User-Agent': 'Binance-Node-Bot-Client' // Thêm User-Agent header
    }
  };

  // Debug log để kiểm tra full URL và headers (chỉ một phần API Key)
  addLog(`[DEBUG API CALL] Full Request URL: https://${options.hostname}${options.path}`);
  addLog(`[DEBUG API CALL] API Key Sent (first 5 chars): ${apiKey.substring(0, 5)}...`); 

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
          addLog(`❌ Lỗi API phản hồi cho ${endpoint}: ${res.statusCode} - ${errorMsg}`); // Log lỗi phản hồi
          reject(new Error(`API lỗi ${endpoint}: ${res.statusCode} - ${errorMsg}`));
        }
      });
    });
    req.on('error', err => {
        addLog(`❌ Lỗi request đến ${endpoint}: ${err.message}`); // Log lỗi network
        reject(new Error(`Lỗi request đến ${endpoint}: ${err.message}`));
    });
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
  if (exchangeInfoCache) {
    addLog('>>> Đã có cache exchangeInfo. Trả về cache.');
    return exchangeInfoCache;
  }

  addLog('>>> Đang lấy exchangeInfo từ Binance...');
  try {
    const url = `https://${BASE_URL}/fapi/v1/exchangeInfo`;
    // CHỈ DÙNG fetch TRỰC TIẾP, KHÔNG CẦN KÝ (UNSIGNED ENDPOINT)
    const res = await fetch(url); 

    if (!res.ok) {
      const errorText = await res.text();
      addLog(`❌ Lỗi HTTP khi lấy exchangeInfo: ${res.status} - ${errorText}`);
      throw new Error(`Failed to get exchangeInfo: ${res.statusText}`);
    }

    const data = await res.json();
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
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 0,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision
      };
    });
    addLog('>>> Đã tải thông tin sàn và cache thành công.');
    return exchangeInfoCache;
  } catch (error) {
    addLog('Lỗi khi lấy exchangeInfo: ' + error.message);
    exchangeInfoCache = null; // Xóa cache nếu có lỗi
    return null;
  }
}

// Hàm mới để lấy đòn bẩy tối đa từ API leverageBracket
async function getLeverageBracket(symbol) {
  try {
    const url = `https://${BASE_URL}/fapi/v1/leverageBracket?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to get leverageBracket for ${symbol}: ${res.status} - ${errorText}`);
    }
    const data = await res.json();
    // leverageBracket trả về một mảng, phần tử đầu tiên (index 0) của mảng thường chứa thông tin đòn bẩy tối đa
    // initialLeverage của bracket cuối cùng trong mảng đó thường là đòn bẩy tối đa mà bạn có thể đặt
    if (data && data.length > 0 && data[0].leverageBrackets && data[0].leverageBrackets.length > 0) {
        const brackets = data[0].leverageBrackets;
        // Lấy initialLeverage của bracket cuối cùng
        return parseInt(brackets[brackets.length - 1].initialLeverage);
    }
    return null; // Không tìm thấy đòn bẩy
  } catch (error) {
    addLog(`❌ Lỗi khi lấy leverageBracket cho ${symbol}: ${error.message}`);
    return null;
  }
}

// Hàm kết hợp để lấy tất cả filters và maxLeverage
async function getMaxLeverageAndFilters(symbol) {
  const filters = await getExchangeInfo(); // Lấy các filter từ exchangeInfo (minQty, stepSize, ...)
  const maxLeverage = await getLeverageBracket(symbol); // Lấy maxLeverage từ API leverageBracket

  if (filters && filters[symbol]) {
    return {
      ...filters[symbol],
      maxLeverage: maxLeverage // Thêm maxLeverage vào đối tượng filters
    };
  }
  return null;
}


async function getCurrentPrice(symbol) {
  try {
    const response = await fetch(`https://${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
    if (!response.ok) {
      throw new Error(`Failed to get price for ${symbol}: ${response.statusText}`);
    }
    const data = await response.json();
    const price = parseFloat(data.price);
    return price;
  } catch (error) {
    addLog(`Lỗi khi lấy giá cho ${symbol}: ${error.message}`);
    return null;
  }
}

/***************** ĐẶT & ĐÓNG LỆNH  *****************/
async function placeShortOrder(symbol, currentFundingRate, bestFundingTime) {
  try {
    const account = await callSignedAPI('/fapi/v2/account');
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    const balance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;

    if (balance < 0.15) {
      addLog(`>>> Không đủ balance để mở lệnh. Balance hiện tại: ${balance}`);
      return;
    }

    const symbolFilters = await getMaxLeverageAndFilters(symbol);
    // Kiểm tra lại lần nữa để đảm bảo có thông tin đòn bẩy trước khi đặt lệnh
    if (!symbolFilters || !symbolFilters.maxLeverage || symbolFilters.maxLeverage <= 1) {
        addLog(`>>> Lỗi: Không có thông tin đòn bẩy hợp lệ cho ${symbol} khi mở lệnh. (MaxLeverage: ${symbolFilters ? symbolFilters.maxLeverage : 'N/A'})`);
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
      leverage: maxLeverage
    });
    addLog(`Đã đặt đòn bẩy ${maxLeverage}x cho ${symbol}.`);

    const capital = balance * 0.8; // 80% vốn
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
      quantity: quantity
    });

    // Thông tin sau khi lệnh được mở thành công (log này sẽ hiển thị nếu lệnh thành công)
    const openTime = new Date(); // Thời gian ngay khi lệnh được mở
    const formattedOpenTime = `${openTime.toLocaleDateString()} ${openTime.toLocaleTimeString('en-US', { hour12: false })}.${String(openTime.getMilliseconds()).padStart(3, '0')}`;
    addLog(`Lệnh mở lúc: ${formattedOpenTime}`);
    addLog(`>>> Đã mở lệnh SHORT thành công cho ${symbol}`);
    addLog(`  + Funding Rate: ${currentFundingRate}`);
    addLog(`  + Đòn bẩy sử dụng: ${maxLeverage}x`);
    addLog(`  + Số tiền USDT vào lệnh: ${capital.toFixed(2)} USDT`); // Đây là số tiền vốn thực tế được sử dụng để tính qty
    addLog(`  + Khối lượng: ${quantity} ${symbol}`);
    addLog(`  + Giá vào lệnh: ${price}`);


    const entryPrice = parseFloat(order.avgFillPrice || price);
    const tpSlValue = (maxLeverage / 100) * capital; // Tính toán giá trị TP/SL dựa trên vốn và đòn bẩy
    const tpPrice = entryPrice - (tpSlValue / quantity);
    const slPrice = entryPrice + (tpSlValue / quantity);
    addLog(`>>> Giá TP: ${tpPrice.toFixed(symbolFilters.pricePrecision)}, Giá SL: ${slPrice.toFixed(symbolFilters.pricePrecision)}`);

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

        // Cập nhật log đếm giây ở cuối
        addLog(`>>> Đang kiểm tra TP/SL cho ${symbol}... Đã kiểm tra ${checkCount} / ${maxCheck} giây`);

        if (currentPrice !== null) { // Đảm bảo giá không null
          if (currentPrice <= tpPrice) {
            addLog(`>>> Giá đạt TP: ${currentPrice.toFixed(symbolFilters.pricePrecision)}. Đóng lệnh ngay.`);
            clearInterval(checkInterval);
            await closeShortPosition(symbol, quantity);
          } else if (currentPrice >= slPrice) {
            addLog(`>>> Giá đạt SL: ${currentPrice.toFixed(symbolFilters.pricePrecision)}. Đóng lệnh ngay.`);
            clearInterval(checkInterval);
            await closeShortPosition(symbol, quantity);
          } else if (checkCount >= maxCheck) {
            addLog(`>>> Quá ${maxCheck} giây chưa đạt TP/SL. Đóng lệnh.`);
            clearInterval(checkInterval);
            await closeShortPosition(symbol, quantity);
          }
        }
      } catch (error) {
        addLog('Lỗi khi check TP/SL: ' + error.message);
      }
    }, 1000); // Kiểm tra mỗi giây
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
      if (!closePrice) {
          addLog(`Không thể lấy giá đóng lệnh cho ${symbol}. Hủy đóng lệnh.`);
          return;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const symbolFilters = await getMaxLeverageAndFilters(symbol);
      const quantityPrecision = symbolFilters ? symbolFilters.quantityPrecision : 3;

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
      addLog(`>>> Đã đóng lệnh SHORT ${symbol} tại giá ${closePrice.toFixed(symbolFilters.pricePrecision)}`);
      addLog(`>>> Lợi nhuận tạm tính: ${pnl.toFixed(2)} USDT`);
    } else {
      addLog('>>> Không có vị thế SHORT để đóng.');
    }
  } catch (error) {
    addLog('Lỗi khi đóng lệnh: ' + error.message);
  }
}

// Hàm lấy Funding Rates từ Binance
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
    throw error;
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
    const allFundingData = await getFundingRatesFromBinance();
    const fundingRates = allFundingData.map(item => ({
      symbol: item.symbol,
      fundingRate: item.lastFundingRate,
      fundingTime: item.nextFundingTime
    }));
    addLog(`>>> Đã lấy ${fundingRates.length} coin từ API Binance`);

    const candidates = []; // Dùng mảng tạm để lưu các coin đủ điều kiện

    // Luôn tải exchangeInfo một lần trước khi lặp qua các symbol (chỉ lấy filters, không có maxLeverage)
    await getExchangeInfo();

    for (const r of fundingRates) {
        if (parseFloat(r.fundingRate) < -0.0001) {
            const symbolData = await getMaxLeverageAndFilters(r.symbol); // Hàm này giờ lấy cả filters và maxLeverage

            // Kiểm tra xem có maxLeverage hợp lệ và lớn hơn 1 không
            if (symbolData && symbolData.maxLeverage && symbolData.maxLeverage > 1) {
                // Lấy balance và giá hiện tại để ước tính số tiền vào lệnh
                const currentPrice = await getCurrentPrice(r.symbol);
                if (!currentPrice) {
                    addLog(`[DEBUG] Bỏ qua ${r.symbol}: Không lấy được giá hiện tại để ước tính vốn.`);
                    continue; // Bỏ qua nếu không lấy được giá
                }
                const account = await callSignedAPI('/fapi/v2/account');
                const usdtAsset = account.assets.find(a => a.asset === 'USDT');
                const balance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
                const estimatedCapital = (balance * 0.8).toFixed(2); // Ước tính 80% vốn

                candidates.push({
                    ...r,
                    maxLeverage: symbolData.maxLeverage, // Sử dụng maxLeverage đã lấy được
                    estimatedCapital: estimatedCapital,
                    currentPrice: currentPrice // Lưu giá hiện tại để dùng cho log
                });
            } else {
                addLog(`[DEBUG] Bỏ qua ${r.symbol} vì không tìm thấy đòn bẩy hợp lệ (${symbolData ? symbolData.maxLeverage : 'N/A'}x).`);
            }
        }
    }
    candidates.sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

    if (candidates.length > 0) {
      const best = candidates[0];
      selectedSymbol = best.symbol;
      const waitTime = best.fundingTime + 500 - (Date.now() + serverTimeOffset); // Đợi thêm 500ms sau funding

      const projectedOpenTime = new Date(Date.now() + waitTime);
      const formattedProjectedOpenTime = `${projectedOpenTime.toLocaleDateString()} ${projectedOpenTime.toLocaleTimeString('en-US', { hour12: false })}.${String(projectedOpenTime.getMilliseconds()).padStart(3, '0')}`;

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
    addLog('Lỗi cron job: ' + error.message);
  }
});

// Thêm một đoạn code nhỏ để kiểm tra API ngay khi khởi động
// Điều này giúp bạn thấy log lỗi ngay lập tức
(async () => {
  addLog('>>> [Khởi động] Đang kiểm tra API Key với Binance...');
  try {
    const account = await callSignedAPI('/fapi/v2/account');
    addLog('✅ [Khởi động] API Key hoạt động bình thường! Balance: ' + account.assets.find(a => a.asset === 'USDT')?.availableBalance);
  } catch (error) {
    addLog('❌ [Khởi động] API Key không hoạt động hoặc có lỗi: ' + error.message);
    addLog('   -> Nếu lỗi là "-2014 API-key format invalid.", hãy kiểm tra lại API Key/Secret của bạn (chữ hoa/thường, khoảng trắng) hoặc giới hạn IP trên Binance.');
    addLog('   -> Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", hãy kiểm tra lại việc đồng bộ thời gian trên VPS (`sudo ntpdate pool.ntp.org` và `sudo timedatectl set-timezone UTC`).');
  }
})();
