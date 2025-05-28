/***************** CẤU HÌNH CHUNG  *****************/
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');

const app = express();
const port = 3000;

// === API KEY & SECRET ===
const apiKey = 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A';
const apiSecret = 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm';

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_URL = 'fapi.binance.com';

// Cache để lưu thông tin exchangeInfo, tránh gọi API nhiều lần
let exchangeInfoCache = null;

/***************** HÀM KÝ & GỌI API  *****************/
/**
 * Tạo chữ ký HMAC SHA-256
 * @param {string} queryString - Chuỗi query cần ký.
 * @param {string} secret - API Secret.
 * @returns {string} Chữ ký hex.
 */
function getSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Hàm chung để gọi API có ký của Binance Futures.
 * @param {string} endpoint - Phần cuối của URL API (ví dụ: '/fapi/v2/account').
 * @param {string} method - Phương thức HTTP (GET, POST, PUT, DELETE). Mặc định là 'GET'.
 * @param {Object} params - Các tham số query dưới dạng object.
 * @returns {Promise<Object>} Dữ liệu JSON trả về từ API.
 */
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
  const timestamp = Date.now();
  const recvWindow = 60000; // Thời gian hiệu lực của request (ms)

  // Kết hợp các tham số mặc định và tham số truyền vào
  const allParams = {
    timestamp,
    recvWindow,
    ...params
  };

  // Chuyển object params thành query string
  const queryString = Object.keys(allParams)
    .sort() // Sắp xếp các tham số theo thứ tự alphabet để đảm bảo chữ ký nhất quán
    .map(key => `${key}=${allParams[key]}`)
    .join('&');

  const signature = getSignature(queryString, apiSecret);
  const fullPath = `${endpoint}?${queryString}&signature=${signature}`;

  const options = {
    hostname: BASE_URL,
    path: fullPath,
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/json'
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
          reject(new Error(`API lỗi ${endpoint}: ${res.statusCode} - ${body}`));
        }
      });
    });
    req.on('error', err => reject(new Error(`Lỗi request đến ${endpoint}: ${err.message}`)));
    req.end();
  });
}

// Ví dụ gọi nhanh API lấy tài khoản futures – giữ nguyên từ code 1 để test
async function callFuturesAccount() {
  try {
    const accountInfo = await callSignedAPI('/fapi/v2/account');
    console.log('✅ Futures account info:', accountInfo);
  } catch (error) {
    console.error('❌ Lỗi khi gọi tài khoản futures:', error.message);
  }
}


/***************** LOG & BIẾN TRẠNG THÁI  *****************/
let logs = [];
let botRunning = false;
let selectedSymbol = null;

function addLog(msg) {
  const time = new Date().toLocaleString();
  const row = `[${time}] ${msg}`;
  console.log(row);
  logs.push(row);
  if (logs.length > 1000) logs.shift();
}

/***************** ROUTES HTTP  *****************/
app.use(express.json());
app.use('/bot', express.static(path.join(__dirname)));
app.get('/', (req, res) => res.send('Funding bot is running!'));

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> /balance được gọi');
    const account = await callSignedAPI('/fapi/v2/account');
    const usdt = account.assets.find(a => a.asset === 'USDT');
    res.json({
      balance: usdt ? parseFloat(usdt.availableBalance) : 0
    });
  } catch (e) {
    addLog('Lỗi /balance: ' + e.message);
    res.status(500).json({
      error: e.message
    });
  }
});

app.get('/funding', async (_, res) => {
  try {
    const opts = {
      hostname: BASE_URL,
      path: '/fapi/v1/premiumIndex',
      method: 'GET'
    };
    const funding = await new Promise((resolve, reject) => {
      const r = https.request(opts, rs => {
        let d = '';
        rs.on('data', c => d += c);
        rs.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('Lỗi parse JSON từ /fapi/v1/premiumIndex: ' + d));
          }
        });
      });
      r.on('error', reject);
      r.end();
    });
    res.json(funding.map(f => ({
      symbol: f.symbol,
      fundingRate: parseFloat(f.lastFundingRate),
      time: new Date(f.nextFundingTime).toLocaleString()
    })));
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get('/start', (_, res) => {
  if (!botRunning) {
    botRunning = true;
    addLog('>>> Bot START');
    res.send('Bot started');
  } else res.send('Bot is already running');
});

app.get('/stop', (_, res) => {
  if (botRunning) {
    botRunning = false;
    addLog('>>> Bot STOP');
    res.send('Bot stopped');
  } else res.send('Bot is not running');
});

app.get('/status', (_, res) => res.json({
  running: botRunning,
  currentSymbol: selectedSymbol,
  logCount: logs.length
}));

app.get('/logs', (_, res) => res.json(logs));

app.listen(port, () => addLog(`Server chạy tại http://localhost:${port}`));

/***************** HÀM TIỆN ÍCH  *****************/

/**
 * Lấy thông tin filter (LOT_SIZE, PRICE_FILTER, LEVERAGE) cho một symbol.
 * @param {string} symbol - Mã cặp tiền tệ.
 * @returns {Promise<Object|null>} Object chứa các filter, hoặc null nếu không tìm thấy.
 */
async function getSymbolFilters(symbol) {
  if (!exchangeInfoCache) {
    const response = await fetch(`https://${BASE_URL}/fapi/v1/exchangeInfo`);
    if (!response.ok) {
      throw new Error(`Không thể lấy thông tin sàn giao dịch: ${response.statusText}`);
    }
    exchangeInfoCache = await response.json();
  }

  const symbolInfo = exchangeInfoCache.symbols.find(s => s.symbol === symbol);
  if (!symbolInfo) {
    addLog(`Không tìm thấy thông tin cho symbol: ${symbol}`);
    return null;
  }

  const filters = {};
  symbolInfo.filters.forEach(f => {
    filters[f.filterType] = f;
  });
  return filters;
}

/**
 * Lấy giá hiện tại của một cặp tiền tệ.
 * @param {string} symbol - Mã cặp tiền tệ (ví dụ: 'BTCUSDT').
 * @returns {Promise<number>} Giá hiện tại.
 */
async function getPrice(symbol) {
  const response = await fetch(`https://${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  if (!response.ok) {
    throw new Error(`Không thể lấy giá cho ${symbol}: ${response.statusText}`);
  }
  const data = await response.json();
  return parseFloat(data.price);
}

/**
 * Lấy đòn bẩy tối đa cho một cặp tiền tệ.
 * @param {string} symbol - Mã cặp tiền tệ.
 * @returns {Promise<number|null>} Đòn bẩy tối đa hoặc null nếu không tìm thấy.
 */
async function getMaxLeverage(symbol) {
  const filters = await getSymbolFilters(symbol);
  if (filters && filters.LEVERAGE) {
    return parseInt(filters.LEVERAGE.maxLeverage);
  }
  return null;
}

/***************** ĐẶT & ĐÓNG LỆNH  *****************/
/**
 * Thực hiện lệnh Short cho một cặp tiền tệ.
 * @param {string} symbol - Mã cặp tiền tệ.
 */
async function placeShort(symbol) {
  addLog(`>>> Đang cố gắng SHORT ${symbol}...`);
  try {
    const acc = await callSignedAPI('/fapi/v2/account');
    const usdt = acc.assets.find(a => a.asset === 'USDT');
    const bal = usdt ? parseFloat(usdt.availableBalance) : 0;

    if (bal < 0.15) {
      return addLog('>>> Balance quá thấp. Cần ít nhất 0.15 USDT để đặt lệnh.');
    }

    const lev = await getMaxLeverage(symbol);
    if (!lev) {
      return addLog(`Không tìm thấy đòn bẩy tối đa cho ${symbol}.`);
    }

    const price = await getPrice(symbol);
    if (!price) {
      return addLog(`Không thể lấy giá cho ${symbol}.`);
    }

    // Lấy các filter cần thiết cho symbol
    const symbolFilters = await getSymbolFilters(symbol);
    if (!symbolFilters || !symbolFilters.LOT_SIZE || !symbolFilters.PRICE_FILTER) {
      return addLog(`Không thể lấy thông tin filter cho ${symbol}.`);
    }

    const lotSizeFilter = symbolFilters.LOT_SIZE;
    const priceFilter = symbolFilters.PRICE_FILTER;

    const minQty = parseFloat(lotSizeFilter.minQty);
    const maxQty = parseFloat(lotSizeFilter.maxQty);
    const stepSize = parseFloat(lotSizeFilter.stepSize);

    const tickSize = parseFloat(priceFilter.tickSize);

    // Sử dụng 80% số dư có sẵn để tính toán số lượng
    const cap = bal * 0.8;
    let qty = (cap * lev) / price;

    // Làm tròn quantity theo stepSize
    // Cách làm tròn chuẩn nhất là chia cho stepSize, làm tròn xuống, rồi nhân lại với stepSize
    qty = Math.floor(qty / stepSize) * stepSize;

    // Đảm bảo quantity nằm trong khoảng minQty và maxQty
    if (qty < minQty) {
      addLog(`Tính toán quantity (${qty.toFixed(8)}) nhỏ hơn minQty (${minQty}). Đặt về minQty.`);
      qty = minQty;
    }
    if (qty > maxQty) {
      addLog(`Tính toán quantity (${qty.toFixed(8)}) lớn hơn maxQty (${maxQty}). Đặt về maxQty.`);
      qty = maxQty;
    }

    // Đảm bảo quantity hợp lệ và lớn hơn 0
    if (qty <= 0) {
      return addLog(`Số lượng tính toán cho ${symbol} quá nhỏ hoặc bằng 0 sau khi làm tròn: ${qty}.`);
    }

    // Làm tròn giá TP/SL theo tickSize nếu cần
    const roundPrice = (p, tick) => Math.round(p / tick) * tick;
    const tpPrice = roundPrice(price - (cap * 0.5) / qty, tickSize);
    const slPrice = roundPrice(price + (cap * 0.5) / qty, tickSize);


    // 1. Đặt đòn bẩy
    await callSignedAPI('/fapi/v1/leverage', 'POST', {
      symbol: symbol,
      leverage: lev
    });
    addLog(`Đã đặt đòn bẩy ${lev}x cho ${symbol}.`);

    // 2. Đặt lệnh SHORT (SELL) MARKET
    await callSignedAPI('/fapi/v1/order', 'POST', {
      symbol: symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: qty.toFixed(8) // Gửi quantity dưới dạng chuỗi với đủ số thập phân
    });
    addLog(`>>> ĐÃ SHORT ${symbol} với số lượng ${qty.toFixed(8)}.`);


    addLog(`TP dự kiến: ${tpPrice.toFixed(8)}, SL dự kiến: ${slPrice.toFixed(8)}`);


    let ticks = 0;
    const watcher = setInterval(async () => {
      if (!botRunning) {
        clearInterval(watcher);
        addLog(`Watcher cho ${symbol} dừng do bot đã tắt.`);
        return;
      }

      const currentPrice = await getPrice(symbol);
      ticks++;

      // Điều kiện đóng lệnh: đạt TP/SL hoặc quá thời gian (180 giây)
      if (currentPrice <= tpPrice || currentPrice >= slPrice || ticks > 180) {
        clearInterval(watcher);
        addLog(`Đang đóng lệnh SHORT ${symbol} tại giá ${currentPrice.toFixed(8)}...`);
        try {
          await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: qty.toFixed(8) // Đảm bảo quantity khớp khi đóng lệnh
          });
          addLog(`>>> ĐÃ ĐÓNG LỆNH SHORT ${symbol} tại ${currentPrice.toFixed(8)}.`);
        } catch (closeError) {
          addLog(`Lỗi khi đóng lệnh SHORT ${symbol}: ${closeError.message}`);
        }
      }
    }, 1000);

  } catch (e) {
    addLog('Lỗi khi thực hiện lệnh SHORT: ' + e.message);
  }
}

/***************** CRON KIỂM TRA FUNDING  *****************/
cron.schedule('*/1 * * * *', async () => {
  if (!botRunning) {
    return addLog('[Cron] Bot OFF.');
  }

  addLog('[Cron] Kiểm tra funding...');
  try {
    const response = await fetch(`https://${BASE_URL}/fapi/v1/premiumIndex`);
    if (!response.ok) {
      throw new Error(`Không thể lấy premiumIndex: ${response.statusText}`);
    }
    const fund = await response.json();

    const rates = fund.map(x => ({
      symbol: x.symbol,
      rate: parseFloat(x.lastFundingRate),
      time: parseInt(x.nextFundingTime)
    }));

    const neg = rates.filter(r => r.rate < -0.0001).sort((a, b) => a.rate - b.rate);

    if (!neg.length) {
      addLog('>>> Không có coin funding âm đáng kể.');
      selectedSymbol = null;
      return;
    }

    const best = neg[0];
    selectedSymbol = best.symbol;

    const waitTime = best.time - Date.now() - 500; // Đợi đến trước thời điểm funding 500ms

    if (waitTime > 0) {
      addLog(`Chờ ${(waitTime / 1000).toFixed(1)}s để mở lệnh ${best.symbol} (Rate: ${best.rate}).`);
      await new Promise(r => setTimeout(r, waitTime));
    } else {
      addLog(`Đến hoặc đã qua thời gian funding cho ${best.symbol}. Tiến hành mở lệnh ngay.`);
    }

    await new Promise(r => setTimeout(r, 1000)); // Delay 1 giây sau khi hết thời gian chờ

    await placeShort(best.symbol);

  } catch (e) {
    addLog('Cron error: ' + e.message);
  }
});

/***************** GỌI THỬ FUNCTON DEMO (có thể bỏ)  *****************/
callFuturesAccount();
