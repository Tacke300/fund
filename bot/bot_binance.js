/***************** CẤU HÌNH CHUNG  *****************/
import express from 'express';
import https from 'https';
import crypto from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import cron from 'node-cron';

// Để thay thế __dirname trong ES Modules
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

// === API KEY & SECRET ===
const apiKey = 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A'; // Your API Key
const apiSecret = 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm'; // Your API Secret

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
  const maxLeverage = await
