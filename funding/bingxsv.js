const http = require('http');
const crypto = require('crypto');
const url = require('url');

// API KEY + SECRET của bạn
const API_KEY = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const SECRET_KEY = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

// Cặp coin cần kiểm tra
const SYMBOL = 'BTC-USDT';

// Tạo chữ ký HMAC SHA256
function sign(query) {
  return crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
}

// Hàm gọi API BingX dùng Node.js thuần
function callBingXApi(path, params = {}, auth = false) {
  const baseURL = '/openApi/swap/v2/';
  const hostname = 'open-api.bingx.com';
  const timestamp = Date.now();
  let query = `timestamp=${timestamp}`;
  
  for (const key in params) {
    query += `&${key}=${params[key]}`;
  }

  if (auth) {
    const signature = sign(query);
    query += `&signature=${signature}`;
  }

  const options = {
    hostname,
    path: baseURL + path + '?' + query,
    method: 'GET',
    headers: auth ? {
      'X-BX-APIKEY': API_KEY
    } : {}
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Server HTTP trả về JSON
const server = http.createServer(async (req, res) => {
  if (req.url === '/funding') {
    try {
      const fundingData = await callBingXApi('quote/fundingRate', { symbol: SYMBOL });
      const leverageData = await callBingXApi('trade/leverage', { symbol: SYMBOL + ':USDT' }, true);
      const timeData = await callBingXApi('quote/nextFundingTime', { symbol: SYMBOL });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fundingRate: fundingData?.data?.fundingRate,
        maxLeverage: leverageData?.data?.maxLeverage,
        nextFundingTime: timeData?.data?.fundingTime
      }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

// Chạy server trên cổng 5005
server.listen(5005, () => {
  console.log('🟢 Server đang chạy tại http://localhost:5005/funding');
});
