const https = require('https');
const http = require('http');
const crypto = require('crypto');
const url = require('url');

const apiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const secretKey = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

function get(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const baseUrl = 'https://open-api.bingx.com' + endpoint;
    const query = new url.URLSearchParams(params).toString();
    const fullUrl = query ? `${baseUrl}?${query}` : baseUrl;

    https.get(fullUrl, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(`JSON parse error: ${e.message}`);
        }
      });
    }).on('error', reject);
  });
}

function getLeverage(symbol) {
  const timestamp = Date.now();
  const params = `symbol=${symbol}&timestamp=${timestamp}`;
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(params)
    .digest('hex');

  const fullParams = {
    symbol,
    timestamp,
    signature
  };

  return get('/openApi/swap/v2/trade/leverage', fullParams);
}

async function fetchAllFundingAndLeverage() {
  try {
    const result = await get('/openApi/swap/v2/quote/premiumIndex');
    const data = result.data || [];

    const promises = data.map(async item => {
      const symbol = item.symbol;
      let lev = null;
      try {
        const levRes = await getLeverage(symbol);
        lev = levRes?.data?.longMaxLeverage || null;
      } catch (e) {
        lev = null;
      }

      return {
        symbol,
        fundingRate: item.fundingRate,
        nextFundingTime: item.nextFundingTime,
        leverage: lev
      };
    });

    const finalData = await Promise.all(promises);
    return finalData;
  } catch (e) {
    return { error: true, message: e.toString() };
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/funding' && req.method === 'GET') {
    const data = await fetchAllFundingAndLeverage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: true, message: 'Not Found' }));
  }
});

server.listen(5005, () => {
  console.log('Server is running on port 5005');
});
