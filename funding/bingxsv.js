const http = require('http');
const crypto = require('crypto');
const https = require('https');

// Điền API key + secret ở đây
const API_KEY = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const API_SECRET = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

const HOST = 'open-api.bingx.com';

function signParams(params, secret) {
  const ordered = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  return crypto.createHmac('sha256', secret).update(ordered).digest('hex');
}

function fetchBingXFundingRate(callback) {
  const timestamp = Date.now();
  const params = {
    timestamp,
    recvWindow: 5000
  };
  const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const signature = signParams(params, API_SECRET);
  const fullPath = `/openApi/swap/v2/quote/premiumIndex?${queryString}&signature=${signature}`;

  const options = {
    hostname: HOST,
    path: fullPath,
    method: 'GET',
    headers: {
      'X-BX-APIKEY': API_KEY
    }
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (!json.data) return callback(new Error('No data'), null);
        callback(null, json.data);
      } catch (err) {
        callback(err, null);
      }
    });
  });

  req.on('error', err => callback(err, null));
  req.end();
}

function fetchBingXLeverage(symbol, callback) {
  const timestamp = Date.now();
  const params = {
    symbol,
    timestamp,
    recvWindow: 5000
  };
  const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const signature = signParams(params, API_SECRET);
  const fullPath = `/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;

  const options = {
    hostname: HOST,
    path: fullPath,
    method: 'GET',
    headers: {
      'X-BX-APIKEY': API_KEY
    }
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (!json.data) return callback(null, null);
        callback(null, {
          symbol,
          leverage: json.data.longLeverage
        });
      } catch (err) {
        callback(err, null);
      }
    });
  });

  req.on('error', err => callback(err, null));
  req.end();
}

http.createServer((req, res) => {
  if (req.url === '/funding' && req.method === 'GET') {
    fetchBingXFundingRate(async (err, fundingData) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: true, message: err.message }));
      }

      // Lấy max leverage cho từng symbol
      const result = [];
      let count = 0;

      for (const item of fundingData) {
        await new Promise(resolve => {
          fetchBingXLeverage(item.symbol, (levErr, levData) => {
            result.push({
              symbol: item.symbol,
              fundingRate: item.fundingRate,
              nextFundingTime: item.nextFundingTime,
              leverage: levData ? levData.leverage : null
            });
            count++;
            resolve();
          });
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: true, message: 'Not found' }));
  }
}).listen(5005, () => {
  console.log('Server is running on http://localhost:5005');
});
