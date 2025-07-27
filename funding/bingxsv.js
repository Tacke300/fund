const https = require('https');
const crypto = require('crypto');
const http = require('http');

const API_KEY = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const API_SECRET = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function apiGet(path) {
  console.log(`Calling public GET ${path}`);
  const options = {
    hostname: 'open-api.bingx.com',
    port: 443,
    path,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': API_KEY,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Response from ${path}: ${data}`);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error at ${path}: ${e.message}\nData: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`Request error at ${path}:`, err);
      reject(err);
    });
    req.end();
  });
}

function apiGetSigned(path, params = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    params.timestamp = timestamp;

    const query = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&');

    const sign = hmacSha256(API_SECRET, query);

    const fullPath = `${path}?${query}&sign=${sign}`;

    console.log(`Calling signed GET ${fullPath}`);

    const options = {
      hostname: 'open-api.bingx.com',
      port: 443,
      path: fullPath,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': API_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Response from ${fullPath}: ${data}`);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error at ${fullPath}: ${e.message}\nData: ${data}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error(`Request error at ${fullPath}:`, err);
      reject(err);
    });
    req.end();
  });
}

async function fetchData() {
  try {
    console.log('Start fetching contracts list...');
    const contractsData = await apiGet('/openApi/swap/v2/quote/contracts');

    if (!contractsData?.data?.contracts || !Array.isArray(contractsData.data.contracts)) {
      throw new Error('No contracts data found or invalid format');
    }

    const contracts = contractsData.data.contracts;
    console.log(`Got ${contracts.length} contracts`);

    // Lấy max leverage song song cho nhanh
    const leveragePromises = contracts.map(async (contract) => {
      const symbol = contract.symbol;
      const bingxSymbol = symbol.includes(':') ? symbol : symbol + ':USDT';

      let maxLev = null;
      try {
        const levData = await apiGetSigned('/openApi/swap/v2/trade/leverage', { symbol: bingxSymbol });
        if (levData?.data?.maxLeverage) {
          maxLev = levData.data.maxLeverage;
        } else {
          console.warn(`No maxLeverage for ${bingxSymbol}`, levData);
        }
      } catch (e) {
        console.error(`Error fetching max leverage for ${bingxSymbol}:`, e.message);
      }

      return {
        symbol: symbol,
        nextFundingTime: contract.nextFundingTime,
        fundingRate: contract.fundingRate,
        maxLeverage: maxLev,
      };
    });

    const results = await Promise.all(leveragePromises);
    return results;

  } catch (e) {
    console.error('Error in fetchData:', e.message);
    throw e;
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
  console.log('Server listening on http://localhost:5005');
});
