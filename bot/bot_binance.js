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

// Biến lưu trữ lệch thời gian với server Binance
let serverTimeOffset = 0; // Sẽ được tính toán sau

/***************** HÀM KÝ & GỌI API  *****************/
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

async function callSignedAPI(endpoint, method = 'GET', params = {}) {
  // Lấy timestamp bằng cách cộng thời gian cục bộ với độ lệch đã tính toán
  const timestamp = Date.now() + serverTimeOffset;
  const recvWindow = 60000; // Có thể tăng lên nếu mạng bạn có độ trễ cao

  const allParams = {
    timestamp,
    recvWindow,
    ...params
  };

  const sortedKeys = Object.keys(allParams).sort();
  const queryString = sortedKeys
    .map(key => `${key}=${allParams[key]}`)
    .join('&');

  const signature = getSignature(queryString, apiSecret);
  const fullPath = `${endpoint}?${queryString}&signature=${signature}`;

  console.log('\n--- DEBUG API CALL ---');
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Method: ${method}`);
  console.log(`Initial Params: ${JSON.stringify(params)}`);
  console.log(`All Params (with timestamp, recvWindow): ${JSON.stringify(allParams)}`);
  console.log(`Calculated Timestamp (local + offset): ${timestamp}`); // Thêm log này
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
      time: new Date(parseInt(f.nextFundingTime)).toLocaleString()
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

app.listen(port, async () => {
  addLog(`Server chạy tại http://localhost:${port}`);
  await syncServerTime(); // Đồng bộ thời gian khi server khởi động
  // Có thể thêm cron job để đồng bộ lại thời gian định kỳ
  cron.schedule('0 * * * *', async () => { // Đồng bộ mỗi giờ
      addLog('[Cron] Đồng bộ lại thời gian server Binance.');
      await syncServerTime();
  });
});


/***************** HÀM TIỆN ÍCH  *****************/
async function getPrice(symbol) {
  const response = await fetch(`https://${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  if (!response.ok) {
    throw new Error(`Không thể lấy giá cho ${symbol}: ${response.statusText}`);
  }
  const data = await response.json();
  return parseFloat(data.price);
}

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

    const cap = bal * 0.8;
    let qty = (cap * lev) / price;

    const exchangeInfoResponse = await fetch(`https://${BASE_URL}/fapi/v1/exchangeInfo`);
    if (!exchangeInfoResponse.ok) {
        throw new Error(`Không thể lấy exchangeInfo: ${exchangeInfoResponse.statusText}`);
    }
    const exchangeInfo = await exchangeInfoResponse.json();
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);

    if (!symbolInfo) {
        throw new Error(`Không tìm thấy thông tin exchangeInfo cho symbol: ${symbol}`);
    }

    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    const marketLotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');

    let minQty = 0;
    let maxQty = Infinity;
    let stepSize = 0.001;

    const activeLotFilter = marketLotSizeFilter || lotSizeFilter;

    if (activeLotFilter) {
      minQty = parseFloat(activeLotFilter.minQty);
      maxQty = parseFloat(activeLotFilter.maxQty);
      stepSize = parseFloat(activeLotFilter.stepSize);
    } else {
      addLog(`Cảnh báo: Không tìm thấy filter LOT_SIZE hoặc MARKET_LOT_SIZE cho ${symbol}. Sử dụng stepSize mặc định.`);
    }

    qty = Math.max(minQty, Math.min(maxQty, Math.floor(qty / stepSize) * stepSize));

    console.log(`[DEBUG] Symbol: ${symbol}`);
    console.log(`[DEBUG] Initial Quantity: ${qty}`);
    console.log(`[DEBUG] Min Quantity: ${minQty}, Max Quantity: ${maxQty}, Step Size: ${stepSize}`);
    console.log(`[DEBUG] Final calculated Quantity: ${qty}`);

    if (qty <= 0) {
      return addLog(`Số lượng tính toán cho ${symbol} quá nhỏ hoặc bằng 0 sau khi làm tròn: ${qty}.`);
    }

    const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
    if (minNotionalFilter) {
        const minNotional = parseFloat(minNotionalFilter.minNotional);
        const currentNotional = qty * price;
        if (currentNotional < minNotional) {
            return addLog(`Giá trị notional (${currentNotional.toFixed(2)}) cho ${symbol} quá thấp. Cần tối thiểu ${minNotional} USDT.`);
        }
        console.log(`[DEBUG] Notional: ${currentNotional.toFixed(2)} (Min: ${minNotional})`);
    }

    await callSignedAPI('/fapi/v1/leverage', 'POST', {
      symbol: symbol,
      leverage: lev
    });
    addLog(`Đã đặt đòn bẩy ${lev}x cho ${symbol}.`);

    await callSignedAPI('/fapi/v1/order', 'POST', {
      symbol: symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: qty
    });
    addLog(`>>> ĐÃ SHORT ${symbol} với số lượng ${qty.toFixed(3)}.`);

    const tpPrice = price - (cap * 0.5) / qty;
    const slPrice = price + (cap * 0.5) / qty;
    addLog(`TP dự kiến: ${tpPrice.toFixed(3)}, SL dự kiến: ${slPrice.toFixed(3)}`);

    let ticks = 0;
    const watcher = setInterval(async () => {
      if (!botRunning) {
        clearInterval(watcher);
        addLog(`Watcher cho ${symbol} dừng do bot đã tắt.`);
        return;
      }

      const currentPrice = await getPrice(symbol);
      ticks++;

      if (currentPrice <= tpPrice || currentPrice >= slPrice || ticks > 180) {
        clearInterval(watcher);
        addLog(`Đang đóng lệnh SHORT ${symbol} tại giá ${currentPrice.toFixed(3)}...`);
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

    // Thời gian chờ để mở lệnh (trước thời điểm funding 500ms)
    const waitTime = best.time - (Date.now() + serverTimeOffset) - 500;

    if (waitTime > 0) {
      addLog(`Chờ ${(waitTime / 1000).toFixed(1)}s để mở lệnh ${best.symbol} (Rate: ${best.rate}).`);
      await new Promise(r => setTimeout(r, waitTime));
    } else {
      addLog(`Đến hoặc đã qua thời gian funding cho ${best.symbol}. Tiến hành mở lệnh ngay.`);
    }

    await new Promise(r => setTimeout(r, 1000)); // Delay 1 giây sau khi chờ hoặc ngay lập tức

    await placeShort(best.symbol);

  } catch (e) {
    addLog('Cron error: ' + e.message);
  }
});

/***************** GỌI THỬ FUNCTON DEMO (có thể bỏ)  *****************/
// Sau khi server khởi động và đã đồng bộ thời gian
// callFuturesAccount();
