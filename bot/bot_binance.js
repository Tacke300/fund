const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');

const app = express();
const port = 3000;

const apiKey = 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A';
const apiSecret = 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm';

let logs = [];
let botRunning = false;
let selectedSymbol = null;

function addLog(message) {
  const time = new Date().toLocaleString();
  const entry = `[${time}] ${message}`;
  console.log(entry);
  logs.push(entry);
  if (logs.length > 10000) logs.shift();
}

function signQuery(queryString) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

function callSignedAPI(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    let queryString = `timestamp=${timestamp}&recvWindow=5000`;
    if (data) queryString += '&' + data;
    const signature = signQuery(queryString);
    const fullPath = `${path}?${queryString}&signature=${signature}`;

    const options = {
      hostname: 'fapi.binance.com',
      path: fullPath,
      method,
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Lỗi parse JSON: ' + body));
        }
      });
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

app.use('/bot', express.static(path.join(__dirname)));
app.get('/', (req, res) => res.send('Funding bot is running!'));

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> Gọi /balance');
    const account = await callSignedAPI('/fapi/v2/account');
    const usdt = account.assets.find(a => a.asset === 'USDT');
    res.json({ balance: usdt ? usdt.availableBalance : 0 });
  } catch (error) {
    addLog('Lỗi /balance: ' + error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/funding', async (req, res) => {
  try {
    const options = {
      hostname: 'fapi.binance.com',
      path: '/fapi/v1/premiumIndex',
      method: 'GET'
    };
    const fundingRates = await new Promise((resolve, reject) => {
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', err => reject(err));
      req.end();
    });
    const simplified = fundingRates.map(f => ({
      symbol: f.symbol,
      fundingRate: f.lastFundingRate,
      time: new Date(f.nextFundingTime).toLocaleString()
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
    res.send('Bot đang chạy rồi');
  }
});

app.get('/stop', (req, res) => {
  if (botRunning) {
    botRunning = false;
    addLog('>>> Bot đã dừng');
    res.send('Bot stopped');
  } else {
    res.send('Bot chưa chạy');
  }
});

app.get('/status', (req, res) => {
  res.json({ running: botRunning, currentSymbol: selectedSymbol, logCount: logs.length });
});

app.get('/logs', (req, res) => {
  res.json(logs);
});

app.listen(port, () => {
  addLog(`Server chạy tại http://localhost:${port}`);
});

async function getPrice(symbol) {
  const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + symbol);
  const json = await res.json();
  return parseFloat(json.price);
}

async function getLeverage(symbol) {
  const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const data = await res.json();
  const item = data.symbols.find(s => s.symbol === symbol);
  const filter = item.filters.find(f => f.filterType === 'LEVERAGE');
  return filter ? parseInt(filter.maxLeverage) : null;
}

async function placeShort(symbol) {
  try {
    const account = await callSignedAPI('/fapi/v2/account');
    const usdt = account.assets.find(a => a.asset === 'USDT');
    const balance = usdt ? parseFloat(usdt.availableBalance) : 0;
    if (balance < 0.15) {
      addLog('>>> Không đủ tiền mở lệnh');
      return;
    }

    const leverage = await getLeverage(symbol);
    const price = await getPrice(symbol);
    const capital = balance * 0.8;
    const quantity = (capital * leverage) / price;

    // Set leverage
    await callSignedAPI('/fapi/v1/leverage', 'POST', `symbol=${symbol}&leverage=${leverage}`);

    // Market sell
    await callSignedAPI('/fapi/v1/order', 'POST', `symbol=${symbol}&side=SELL&type=MARKET&quantity=${quantity}`);

    addLog(`>>> SHORT ${symbol} thành công với khối lượng ${quantity.toFixed(3)}`);

    // Giả định TP/SL = ±50% vốn gốc
    const tp = price - (capital * 0.5) / quantity;
    const sl = price + (capital * 0.5) / quantity;

    let checkCount = 0;
    const checkInterval = setInterval(async () => {
      const currentPrice = await getPrice(symbol);
      checkCount++;
      if (currentPrice <= tp || currentPrice >= sl || checkCount > 180) {
        clearInterval(checkInterval);
        await callSignedAPI('/fapi/v1/order', 'POST', `symbol=${symbol}&side=BUY&type=MARKET&quantity=${quantity}`);
        addLog(`>>> Đóng lệnh SHORT ${symbol}. Giá hiện tại: ${currentPrice}`);
      }
    }, 1000);
  } catch (e) {
    addLog('Lỗi mở lệnh SHORT: ' + e.message);
  }
}
