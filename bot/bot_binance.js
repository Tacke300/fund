const express = require('express');
const Binance = require('node-binance-api');
const app = express();
const port = 3000;

let logs = [];
function addLog(message) {
  const time = new Date().toLocaleString();
  const logEntry = `[${time}] ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 100) logs.shift();
}

app.get('/', (req, res) => {
  res.send('Funding bot is running!');
});

const binance = new Binance().options({
  APIKEY: 'ynfUQ5PxqqWQJdwPsAVREudagiF1WEN3HAENgLZIwWC3VrsNnT74wlRwY29hGXZky',
  APISECRET: 'pYTcusasHde67ajzvaOmgmSReqbZ7f0j2uwfR3VaeHai1emhuWRcacmlBCnrRglH'
});


  response.forEach(item => {
    console.log(item.symbol, item.fundingRate);
    // xử lý item là object, có trường symbol, fundingRate...
  });
});

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> /balance được gọi');
    const account = await binance.futuresAccount();
    const usdtAsset = account.assets.find(asset => asset.asset === 'USDT');
    res.json({ balance: usdtAsset.availableBalance });
  } catch (error) {
    addLog('Lỗi trong /balance: ' + error.message);
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(__dirname));

const cron = require('node-cron');
addLog('>>> [Cron] Bắt đầu chạy rồi nè!');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let selectedSymbol = null;

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  addLog(`Server started on port ${port}`);
});

let botRunning = false;

cron.schedule('*/1 * * * *', async () => {
  if (!botRunning) {
    addLog('[Cron] Bot đang tắt, không kiểm tra funding.');
    return;
  }

  addLog(`>>> [Cron] Đã tới giờ hoàng đạo kiếm tiền uống bia, đang kiểm tra funding...`);
  try {
    const fundingRates = await binance.futuresFundingRate();
    addLog(`>>> Đã lấy ${fundingRates.length} coin từ API Binance`);

    const negativeRates = fundingRates
      .filter(rate => parseFloat(rate.fundingRate) < -0.0001)
      .sort((a, b) => parseFloat(a.fundingRate) - parseFloat(b.fundingRate));

    if (negativeRates.length > 0) {
      const best = negativeRates[0];
      selectedSymbol = best.symbol;
      const fundingTime = best.fundingTime;
      const now = Date.now();
      const waitTime = fundingTime + 500 - now;

      addLog(`>>> Chọn được coin: ${selectedSymbol} với funding rate ${best.fundingRate}`);
      if (waitTime > 0) {
        addLog(`>>> Sẽ mở lệnh sau ${(waitTime / 1000).toFixed(1)} giây nữa`);
        await delay(waitTime);
      }

      addLog(`>>> Delay 500ms sau funding để chắc chắn nhận funding`);
      await delay(500);
      await placeShortOrder(selectedSymbol);
    } else {
      addLog('>>> Không có coin sắp tới mở lệnh đâu. Đi uống bia chú em ơi!');
      selectedSymbol = null;
    }
  } catch (error) {
    addLog('Lỗi khi kiểm tra funding: ' + error.message);
  }
});

async function getMaxLeverage(symbol) {
  try {
    addLog(`>>> Đang lấy max leverage của ${symbol}`);
    const leverageInfo = await binance.futuresLeverageBracket(symbol);
    if (leverageInfo && leverageInfo.length > 0) {
      const leverage = leverageInfo[0].brackets[0].initialLeverage;
      addLog(`>>> Max leverage của ${symbol} là ${leverage}`);
      return leverage;
    }
    return null;
  } catch (error) {
    addLog('Lỗi lấy leverage: ' + error.message);
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
    const usdtAsset = account.assets.find(asset => asset.asset === 'USDT');
    const balance = parseFloat(usdtAsset.availableBalance);

    if (balance < 0.15) {
      addLog(`>>> Không đủ balance để mở lệnh. Balance hiện tại: ${balance}`);
      return;
    }

    const maxLeverage = await getMaxLeverage(symbol);
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
  const htmlLogs = logs.map(log => `<div class="log-entry">${log}</div>`).join('');
  res.send(`<html>
<head><title>Funding Bot Logs</title>
<style>
body { font-family: 'Courier New', monospace; background-color: #f9f9f9; padding: 30px; color: #111; }
h2 { color: #111; border-bottom: 2px solid #ccc; padding-bottom: 5px; margin-bottom: 20px; }
.log-entry { background: #fff; padding: 10px 15px; margin: 10px 0; border-left: 4px solid #999; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); white-space: pre-wrap; color: #222; }
</style>
</head>
<body>
<h2>📜 Funding Bot Logs</h2>
${htmlLogs}
</body>
</html>`);
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
