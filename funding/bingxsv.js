const https = require('https');
const crypto = require('crypto');
const http = require('http');

const API_KEY = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const API_SECRET = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

function hmacSha256(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// Hàm gọi API GET không auth
function apiGet(path) {
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
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}\nData: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Hàm gọi API GET có auth (cần timestamp + sign)
function apiGetSigned(path, params = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    params.timestamp = timestamp;

    // Tạo query string
    const query = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('&');

    const sign = hmacSha256(API_SECRET, query);

    const fullPath = `${path}?${query}&sign=${sign}`;

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
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}\nData: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function fetchData() {
  // Bước 1: Lấy danh sách contract (symbol + funding + nextFundingTime)
  const contractsData = await apiGet('/openApi/swap/v2/quote/contracts');

  if (!contractsData?.data?.contracts) {
    throw new Error('Không lấy được danh sách contracts');
  }

  const contracts = contractsData.data.contracts;

  // Bước 2: Với từng symbol gọi lấy max leverage
  // BingX yêu cầu format symbol dạng: BTC-USDT:USDT
  // Nên cần tạo symbol có đuôi ":USDT"
  // Lưu ý: Có thể ko phải tất cả symbol đều có max lev trả về, handle null

  const results = [];

  for (const contract of contracts) {
    const symbol = contract.symbol; // VD: BTC-USDT

    const bingxSymbol = symbol.includes(':') ? symbol : symbol + ':USDT';

    let maxLev = null;
    try {
      const levData = await apiGetSigned('/openApi/swap/v2/trade/leverage', { symbol: bingxSymbol });
      if (levData?.data?.maxLeverage) {
        maxLev = levData.data.maxLeverage;
      }
    } catch (e) {
      // nếu lỗi API hoặc không có dữ liệu maxLeverage thì để null
      maxLev = null;
    }

    results.push({
      symbol: symbol,
      nextFundingTime: contract.nextFundingTime,
      fundingRate: contract.fundingRate,
      maxLeverage: maxLev,
    });
  }

  return results;
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
