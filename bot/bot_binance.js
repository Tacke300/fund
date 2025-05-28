const express = require('express');
const Binance = require('node-binance-api');
const https = require('https');
const fetch = require('node-fetch');
const cron = require('node-cron');
const path = require('path');

const app = express();
const port = 3000;

let logs = [];
let botRunning = false;
let selectedSymbol = null;

function addLog(message) {
  const time = new Date().toLocaleString();
  const logEntry = `[${time}] ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 10000) logs.shift();
}

const binance = new Binance().options({
  apiKey: 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A',
  apiSecret: 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm',
  useServerTime: true,
  recvWindow: 60000
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.use('/bot', express.static(path.join(__dirname)));

app.get('/', (req, res) => res.send('Funding bot is running!'));

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> /balance được gọi');
    const account = await binance.futuresAccount();
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    res.json({ balance: usdtAsset ? usdtAsset.availableBalance : 0 });
  } catch (error) {
    addLog('Lỗi trong /balance: ' + error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/funding', async (req, res) => {
  try {
    const fundingRates = await binance.futuresFundingRate();
    const simplified = fundingRates.map(item => ({
      symbol: item.symbol,
      fundingRate: item.fundingRate,
      time: new Date(item.fundingTime).toLocaleString()
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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  addLog(`Server started on port ${port}`);
});

async function getFundingRatesFromBinance() {
  return new Promise((resolve, reject) => {
    const options = { hostname: 'fapi.binance.com', path: '/fapi/v1/premiumIndex', method: 'GET' };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Lỗi parse JSON: ' + err.message));
        }
      });
    });
    req.on('error', err => reject(new Error('Lỗi khi gọi API Binance: ' + err.message)));
    req.end();
  });
}

let leverageCache = null;

async function getMaxLeverageCached(symbol) {
  try {
    if (!leverageCache) {
      const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
      if (!res.ok) throw new Error('Failed to get exchangeInfo');
      const data = await res.json();
      leverageCache = {};
      data.symbols.forEach(s => {
        const levFilter = s.filters.find(f => f.filterType === 'LEVERAGE');
        if (levFilter) leverageCache[s.symbol] = parseInt(levFilter.maxLeverage);
      });
    }
    const maxLeverage = leverageCache[symbol] || null;
    addLog(`>>> Max leverage cached của ${symbol}: ${maxLeverage}`);
    return maxLeverage;
  } catch (error) {
    addLog('Lỗi khi lấy max leverage cached: ' + error.message);
    return null;
  }
}

async function getCurrentPrice(symbol) {
  const prices = await binance.futuresPrices();
  const price = parseFloat(prices[symbol]);
  addLog(`>>> Giá hiện tại của ${symbol} là ${price}`);
  return price;
}

async function placeShortOrder(symbol) {
  try {
    addLog(`>>> Bắt đầu mở lệnh SHORT cho ${symbol}`);
    const account = await binance.futuresAccount();
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    const balance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
    
    if (balance < 0.15) {
      addLog(`>>> Không đủ balance để mở lệnh. Balance hiện tại: ${balance}`);
      return;
    }

    const maxLeverage = await getMaxLeverageCached(symbol);
    if (!maxLeverage) {
      addLog('>>> Không lấy được đòn bẩy, hủy mở lệnh.');
      return;
    }

    await binance.futuresLeverage(symbol, maxLeverage);
    const price = await getCurrentPrice(symbol);
    const capital = balance * 0.8;
    const quantity = (capital * maxLeverage) / price;

    const order = await binance.futuresMarketSell(symbol, quantity.toFixed(3));
    addLog(`>>> Đã mở lệnh SHORT ${symbol}`);
    addLog(`- Khối lượng: ${quantity.toFixed(3)}`);
    addLog(`- Đòn bẩy: ${maxLeverage}`);
    addLog(`- Giá vào: ${price}`);
    addLog(`- Giá trị lệnh: ${(quantity * price).toFixed(2)} USDT`);

    const entryPrice = parseFloat(order.avgFillPrice || price);
    const tpSlValue = (maxLeverage / 100) * capital;
    const tpPrice = entryPrice - tpSlValue / quantity;
    const slPrice = entryPrice + tpSlValue / quantity;
    addLog(`>>> Giá TP: ${tpPrice.toFixed(2)}, Giá SL: ${slPrice.toFixed(2)}`);

    let checkCount = 0;
    const maxCheck = 180;

    const checkInterval = setInterval(async () => {
      try {
        checkCount++;
        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice <= tpPrice) {
          addLog(`>>> Giá đạt TP: ${currentPrice.toFixed(2)}. Đóng lệnh ngay.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol);
        } else if (currentPrice >= slPrice) {
          addLog(`>>> Giá đạt SL: ${currentPrice.toFixed(2)}. Đóng lệnh ngay.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol);
        } else if (checkCount >= maxCheck) {
          addLog(`>>> Quá 3 phút chưa đạt TP/SL. Đóng lệnh.`);
          clearInterval(checkInterval);
          await closeShortPosition(symbol);
        }
      } catch (error) {
        addLog('Lỗi khi check TP/SL: ' + error.message);
      }
    }, 1000);
  } catch (error) {
    addLog('Lỗi mở lệnh short: ' + error.message);
  }
}

async function closeShortPosition(symbol) {
  try {
    addLog(`>>> Đang đóng lệnh SHORT cho ${symbol}`);
    const positions = await binance.futuresPositionRisk();
    const position = positions.find(p => p.symbol === symbol);

    if (position && parseFloat(position.positionAmt) !== 0) {
      const closePrice = await getCurrentPrice(symbol);
      const qtyToClose = Math.abs(parseFloat(position.positionAmt));
      await binance.futuresMarketBuy(symbol, qtyToClose);

      const entryPrice = parseFloat(position.entryPrice);
      const pnl = (entryPrice - closePrice) * qtyToClose;

      addLog(`>>> Đã đóng lệnh SHORT ${symbol} tại giá ${closePrice.toFixed(2)}`);
      addLog(`>>> Lợi nhuận: ${pnl.toFixed(2)} USDT`);
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
    const allFundingData = await getFundingRatesFromBinance();
    const fundingRates = allFundingData.map(item => ({
      symbol: item.symbol,
      fundingRate: item.lastFundingRate,
      fundingTime: item.nextFundingTime
    }));
    addLog(`>>> Đã lấy ${fundingRates.length} coin từ API Binance`);
    fundingRates.forEach(rate => addLog(`Funding | ${rate.symbol}: ${rate.fundingRate}`));

    const negativeRates = fundingRates
      .filter(r => parseFloat(r.fundingRate) < -0.0001)
      .sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

    if (negativeRates.length > 0) {
      const best = negativeRates[0];
      selectedSymbol = best.symbol;
      const waitTime = best.fundingTime + 500 - Date.now();

      addLog(`>>> Chọn được coin: ${selectedSymbol} | Funding rate: ${best.fundingRate}`);
      if (waitTime > 0) {
        addLog(`- Sẽ mở lệnh sau ${(waitTime / 1000).toFixed(1)} giây`);
        await delay(waitTime);
      }

      addLog('>>> Delay 500ms sau funding để chắc chắn nhận funding');
      await delay(500);
      await placeShortOrder(selectedSymbol);
    } else {
      addLog('>>> Không có coin sắp tới mở lệnh đâu. Đi uống bia
