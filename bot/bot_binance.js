/*****************  CẤU HÌNH CHUNG  *****************/
const express  = require('express');
const https    = require('https');
const crypto   = require('crypto');
const fetch    = require('node-fetch');
const path     = require('path');
const cron     = require('node-cron');

const app  = express();
const port = 3000;

// === API KEY & SECRET ===
const apiKey    = 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A';
const apiSecret = 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm';

/*****************  HÀM KÝ & GỌI API (TỪ CODE 1)  *****************/
// Tạo chữ ký HMAC SHA-256
function getSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Ví dụ gọi nhanh API lấy tài khoản futures – giữ nguyên từ code 1 để test
function callFuturesAccount() {
  const timestamp  = Date.now();
  const recvWindow = 5000;
  const query      = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
  const signature  = getSignature(query, apiSecret);

  const pathAPI = `/fapi/v2/account?${query}&signature=${signature}`;

  const options = {
    hostname: 'fapi.binance.com',
    path:     pathAPI,
    method:   'GET',
    headers:  { 'X-MBX-APIKEY': apiKey }
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('✅ Futures account info:', JSON.parse(data));
      } else {
        console.error('❌ API lỗi:', res.statusCode, data);
      }
    });
  });
  req.on('error', e => console.error('❌ Lỗi request:', e));
  req.end();
}

// Hàm call API có ký, dùng chung cho bot
function callSignedAPI(path, method = 'GET', extraQuery = '') {
  return new Promise((resolve, reject) => {
    const timestamp  = Date.now();
    const recvWindow = 60000;
    let queryString  = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    if (extraQuery) queryString += '&' + extraQuery;

    const signature = getSignature(queryString, apiSecret);
    const fullPath  = `${path}?${queryString}&signature=${signature}`;

    const options = {
      hostname: 'fapi.binance.com',
      path:     fullPath,
      method,
      headers:  { 'X-MBX-APIKEY': apiKey }
    };

    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try   { resolve(JSON.parse(body)); }
        catch { reject(new Error('Lỗi parse JSON: ' + body)); }
      });
    });
    req.on('error', err => reject(err));
    req.end();
  });
}

/*****************  LOG & BIẾN TRẠNG THÁI  *****************/
let logs          = [];
let botRunning    = false;
let selectedSymbol = null;

function addLog(msg) {
  const time = new Date().toLocaleString();
  const row  = `[${time}] ${msg}`;
  console.log(row);
  logs.push(row);
  if (logs.length > 10000) logs.shift();
}

/*****************  ROUTES HTTP  *****************/
app.use('/bot', express.static(path.join(__dirname)));
app.get('/',        (req, res) => res.send('Funding bot is running!'));

app.get('/balance', async (req, res) => {
  try {
    addLog('>>> /balance được gọi');
    const account = await callSignedAPI('/fapi/v2/account');
    const usdt    = account.assets.find(a => a.asset === 'USDT');
    res.json({ balance: usdt ? usdt.availableBalance : 0 });
  } catch (e) {
    addLog('Lỗi /balance: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/funding', async (_, res) => {
  try {
    const opts = { hostname:'fapi.binance.com', path:'/fapi/v1/premiumIndex', method:'GET' };
    const funding = await new Promise((resolve, reject) => {
      const r = https.request(opts, rs => {
        let d = ''; rs.on('data', c => d += c); rs.on('end', () => resolve(JSON.parse(d)));
      });
      r.on('error', reject); r.end();
    });
    res.json(funding.map(f => ({
      symbol: f.symbol,
      fundingRate: f.lastFundingRate,
      time: new Date(f.nextFundingTime).toLocaleString()
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/start', (_, res) => {
  if (!botRunning) { botRunning = true; addLog('>>> Bot START'); res.send('Bot started'); }
  else res.send('Bot is already running');
});
app.get('/stop',  (_, res) => {
  if (botRunning) { botRunning = false; addLog('>>> Bot STOP'); res.send('Bot stopped'); }
  else res.send('Bot is not running');
});
app.get('/status',(_, res) => res.json({ running: botRunning, currentSymbol: selectedSymbol, logCount: logs.length }));
app.get('/logs',  (_, res) => res.json(logs));

app.listen(port, () => addLog(`Server chạy tại http://localhost:${port}`));

/*****************  HÀM TIỆN ÍCH  *****************/
async function getPrice(symbol) {
  const j = await (await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`)).json();
  return parseFloat(j.price);
}
async function getMaxLeverage(symbol) {
  const info = await (await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')).json();
  const f    = info.symbols.find(s => s.symbol === symbol)
                  .filters.find(f => f.filterType === 'LEVERAGE');
  return f ? parseInt(f.maxLeverage) : null;
}

/*****************  ĐẶT & ĐÓNG LỆNH  *****************/
async function placeShort(symbol) {
  try {
    const acc   = await callSignedAPI('/fapi/v2/account');
    const usdt  = acc.assets.find(a => a.asset === 'USDT');
    const bal   = usdt ? parseFloat(usdt.availableBalance) : 0;
    if (bal < 0.15) return addLog('>>> Balance quá thấp.');

    const lev   = await getMaxLeverage(symbol);
    const price = await getPrice(symbol);
    const cap   = bal * 0.8;
    const qty   = (cap * lev) / price;

    await callSignedAPI('/fapi/v1/leverage', 'POST', `symbol=${symbol}&leverage=${lev}`);
    await callSignedAPI('/fapi/v1/order',    'POST', `symbol=${symbol}&side=SELL&type=MARKET&quantity=${qty}`);

    addLog(`>>> ĐÃ SHORT ${symbol} x${lev} qty=${qty.toFixed(3)}`);

    const tp = price - (cap * 0.5) / qty;
    const sl = price + (cap * 0.5) / qty;

    let ticks = 0;
    const watcher = setInterval(async () => {
      const p = await getPrice(symbol);
      ticks++;
      if (p <= tp || p >= sl || ticks > 180) {
        clearInterval(watcher);
        await callSignedAPI('/fapi/v1/order', 'POST', `symbol=${symbol}&side=BUY&type=MARKET&quantity=${qty}`);
        addLog(`>>> CLOSE SHORT ${symbol} at ${p}`);
      }
    }, 1000);

  } catch (e) { addLog('Lỗi SHORT: ' + e.message); }
}

/*****************  CRON KIỂM TRA FUNDING  *****************/
cron.schedule('*/1 * * * *', async () => {
  if (!botRunning) return addLog('[Cron] Bot OFF.');

  addLog('[Cron] Kiểm tra funding...');
  try {
    const fund = await (await fetch('https://fapi.binance.com/fapi/v1/premiumIndex')).json();
    const rates = fund.map(x => ({ symbol:x.symbol, rate:parseFloat(x.lastFundingRate), time:x.nextFundingTime }));
    const neg   = rates.filter(r => r.rate < -0.0001).sort((a,b) => a.rate - b.rate);
    if (!neg.length) { addLog('>>> Không có coin funding âm.'); return; }

    const best = neg[0];
    selectedSymbol = best.symbol;
    const wait = best.time + 500 - Date.now();
    if (wait > 0) { addLog(`Chờ ${(wait/1000).toFixed(1)}s để mở lệnh ${best.symbol}`); await new Promise(r => setTimeout(r, wait)); }
    await new Promise(r => setTimeout(r, 500));  // Delay sau funding
    await placeShort(best.symbol);

  } catch (e) { addLog('Cron error: ' + e.message); }
});

/*****************  GỌI THỬ FUNCTON DEMO (có thể bỏ)  *****************/
// callFuturesAccount();   // Bỏ comment để test nhanh thông tin tài khoản
