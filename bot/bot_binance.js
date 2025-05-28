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
          reject(new Error(`API lỗi ${endpoint}: ${res.statusCode} - ${body}`));
        }
      });
    });
    req.on('error', err => reject(new Error(`Lỗi request đến ${endpoint}: ${err.message}`)));
    req.end();
  });
}

// Ví dụ gọi nhanh API lấy tài khoản futures – giữ nguyên từ code 1 để test
// Sử dụng hàm callSignedAPI mới
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

/**
 * Thêm log vào bộ nhớ và console.
 * @param {string} msg - Tin nhắn log.
 */
function addLog(msg) {
  const time = new Date().toLocaleString();
  const row = `[${time}] ${msg}`;
  console.log(row);
  logs.push(row);
  // Giới hạn số lượng log để tránh tràn bộ nhớ
  if (logs.length > 1000) logs.shift();
}

/***************** ROUTES HTTP  *****************/
app.use(express.json()); // Sử dụng middleware để parse JSON body cho các request POST
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
      fundingRate: parseFloat(f.lastFundingRate), // Đảm bảo là số
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
  const response = await fetch(`https://${BASE_URL}/fapi/v1/exchangeInfo`);
  if (!response.ok) {
    throw new Error(`Không thể lấy thông tin sàn giao dịch: ${response.statusText}`);
  }
  const info = await response.json();
  const symbolInfo = info.symbols.find(s => s.symbol === symbol);
  if (!symbolInfo) {
    addLog(`Không tìm thấy thông tin cho symbol: ${symbol}`);
    return null;
  }
  const leverageFilter = symbolInfo.filters.find(f => f.filterType === 'LEVERAGE');
  return leverageFilter ? parseInt(leverageFilter.maxLeverage) : null;
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

    // Sử dụng 80% số dư có sẵn để tính toán số lượng
    const cap = bal * 0.8;
    // Tính toán quantity: (số vốn * đòn bẩy) / giá hiện tại
    let qty = (cap * lev) / price;

    // Lấy thông tin bước nhảy quantity (stepSize) từ exchangeInfo
    const exchangeInfoResponse = await fetch(`https://${BASE_URL}/fapi/v1/exchangeInfo`);
    const exchangeInfo = await exchangeInfoResponse.json();
    const symbolFilter = exchangeInfo.symbols.find(s => s.symbol === symbol);
    const lotSizeFilter = symbolFilter.filters.find(f => f.filterType === 'LOT_SIZE');

    if (lotSizeFilter) {
      const stepSize = parseFloat(lotSizeFilter.stepSize);
      // Làm tròn quantity theo stepSize
      qty = Math.floor(qty / stepSize) * stepSize;
    } else {
      // Nếu không có stepSize, có thể cần làm tròn đến một số thập phân nhất định
      // Ví dụ: làm tròn đến 3 chữ số thập phân nếu không có stepSize cụ thể
      qty = parseFloat(qty.toFixed(3));
    }

    // Đảm bảo quantity hợp lệ và lớn hơn 0
    if (qty <= 0) {
      return addLog(`Số lượng tính toán cho ${symbol} quá nhỏ hoặc bằng 0: ${qty}.`);
    }

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
      quantity: qty
    });
    addLog(`>>> ĐÃ SHORT ${symbol} với số lượng ${qty.toFixed(3)}.`);

    // Tính toán TP và SL (có thể cần điều chỉnh logic TP/SL của bạn)
    // Hiện tại: TP = giá hiện tại - (50% vốn * đòn bẩy) / số lượng
    // SL = giá hiện tại + (50% vốn * đòn bẩy) / số lượng
    // Logic này có thể cần được xem xét kỹ hơn về mức độ phù hợp với chiến lược của bạn.
    const tpPrice = price - (cap * 0.5) / qty;
    const slPrice = price + (cap * 0.5) / qty;
    addLog(`TP dự kiến: ${tpPrice.toFixed(3)}, SL dự kiến: ${slPrice.toFixed(3)}`);


    let ticks = 0;
    const watcher = setInterval(async () => {
      if (!botRunning) { // Dừng watcher nếu bot bị tắt
        clearInterval(watcher);
        addLog(`Watcher cho ${symbol} dừng do bot đã tắt.`);
        return;
      }

      const currentPrice = await getPrice(symbol);
      ticks++;

      // Điều kiện đóng lệnh: đạt TP/SL hoặc quá thời gian (180 giây)
      if (currentPrice <= tpPrice || currentPrice >= slPrice || ticks > 180) {
        clearInterval(watcher);
        addLog(`Đang đóng lệnh SHORT ${symbol} tại giá ${currentPrice.toFixed(3)}...`);
        // Đóng lệnh bằng lệnh BUY MARKET
        try {
          await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: qty
          });
          addLog(`>>> ĐÃ ĐÓNG LỆNH SHORT ${symbol} tại ${currentPrice.toFixed(3)}.`);
        } catch (closeError) {
          addLog(`Lỗi khi đóng lệnh SHORT ${symbol}: ${closeError.message}`);
        }
      }
    }, 1000); // Kiểm tra mỗi giây

  } catch (e) {
    addLog('Lỗi khi thực hiện lệnh SHORT: ' + e.message);
  }
}

/***************** CRON KIỂM TRA FUNDING  *****************/
// Chạy mỗi phút để kiểm tra
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
      time: parseInt(x.nextFundingTime) // Đảm bảo là số nguyên
    }));

    // Lọc các cặp có funding rate âm đáng kể
    const neg = rates.filter(r => r.rate < -0.0001).sort((a, b) => a.rate - b.rate);

    if (!neg.length) {
      addLog('>>> Không có coin funding âm đáng kể.');
      selectedSymbol = null; // Reset symbol nếu không có kèo
      return;
    }

    const best = neg[0]; // Chọn cặp có funding rate âm nhất
    selectedSymbol = best.symbol;

    // Tính toán thời gian chờ đến trước thời điểm funding 500ms
    const waitTime = best.time - Date.now() - 500;

    if (waitTime > 0) {
      addLog(`Chờ ${(waitTime / 1000).toFixed(1)}s để mở lệnh ${best.symbol} (Rate: ${best.rate}).`);
      await new Promise(r => setTimeout(r, waitTime));
    } else {
      addLog(`Đến hoặc đã qua thời gian funding cho ${best.symbol}. Tiến hành mở lệnh ngay.`);
    }

    // Đặt thêm một độ trễ nhỏ sau khi hết thời gian chờ để đảm bảo funding rate được cập nhật
    await new Promise(r => setTimeout(r, 1000)); // Delay 1 giây

    await placeShort(best.symbol);

  } catch (e) {
    addLog('Cron error: ' + e.message);
  }
});

/***************** GỌI THỬ FUNCTON DEMO (có thể bỏ)  *****************/
callFuturesAccount(); // Bỏ comment để test nhanh thông tin tài khoản
