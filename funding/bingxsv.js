const https = require('https');
const crypto = require('crypto');
const http = require('http');

// ✅ Sẵn API key và secret
const API_KEY = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const API_SECRET = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function apiGet(path) {
  const options = {
    hostname: 'open-api.bingx.com',
    port: 443,
    path,
    method: 'GET',
    headers: {
      'X-API-KEY': API_KEY,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`JSON parse error for ${path}: ${e.message}`));
        }
      });
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

function apiGetSigned(path, params = {}) {
  const timestamp = Date.now();
  params.timestamp = timestamp;

  const query = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const sign = hmacSha256(API_SECRET, query);
  const fullPath = `${path}?${query}&sign=${sign}`;

  const options = {
    hostname: 'open-api.bingx.com',
    port: 443,
    path: fullPath,
    method: 'GET',
    headers: {
      'X-API-KEY': API_KEY,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Signed JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

async function fetchData() {
  try {
    console.log('📥 Fetching contracts list...');
    const contractRes = await apiGet('/openApi/swap/v2/quote/contracts');
    const contracts = contractRes.data;

    if (!Array.isArray(contracts)) throw new Error('Contracts format invalid');

    const results = await Promise.all(contracts.map(async (contract) => {
      const symbol = contract.symbol;

      let maxLev = null;
      try {
        const levRes = await apiGetSigned('/openApi/swap/v2/trade/leverage', { symbol });
        maxLev = levRes?.data?.maxLeverage ?? null;
      } catch (e) {
        console.warn(`⚠️ Leverage error for ${symbol}: ${e.message}`);
      }

      return {
        symbol,
        fundingRate: contract.fundingRate,
        nextFundingTime: contract.nextFundingTime,
        maxLeverage: maxLev,
      };
    }));

    return results;
  } catch (err) {
    console.error('🔥 fetchData error:', err.message);
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/funding') {
    try {
      const data = await fetchData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(5005, () => {
  console.log('🚀 Server running at http://localhost:5005/funding');
});
