const http = require('http');
const crypto = require('crypto');

const API_KEY = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const API_SECRET = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';

const PORT = 5005;

function getTimestamp() {
    return Date.now().toString();
}

function sign(queryString) {
    return crypto
        .createHmac('sha256', API_SECRET)
        .update(queryString)
        .digest('hex');
}

function makeRequest(path, params = {}) {
    return new Promise((resolve, reject) => {
        const timestamp = getTimestamp();
        const query = new URLSearchParams({ ...params, timestamp }).toString();
        const signature = sign(query);
        const fullPath = `${path}?${query}&signature=${signature}`;

        const options = {
            hostname: 'open-api.bingx.com',
            path: `/openApi/swap/v2${fullPath}`,
            method: 'GET',
            headers: {
                'X-BX-APIKEY': API_KEY
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

async function getAllData() {
    try {
        // Step 1: Lấy danh sách symbol
        const symbolRes = await makeRequest('/quote/contracts');
        const symbols = symbolRes?.data?.map(item => item.symbol) || [];

        const result = [];

        for (let symbol of symbols) {
            try {
                const [fundingRes, levRes, nextFundingRes] = await Promise.all([
                    makeRequest('/quote/fundingRate', { symbol }),
                    makeRequest('/trade/leverage', { symbol }),
                    makeRequest('/quote/fundingTime', { symbol }),
                ]);

                result.push({
                    symbol,
                    fundingRate: fundingRes?.data?.fundingRate || null,
                    nextFundingTime: nextFundingRes?.data?.fundingTime || null,
                    maxLeverage: levRes?.data?.maxLeverage || null
                });
            } catch (err) {
                result.push({ symbol, error: true, msg: err.message });
            }
        }

        return result;
    } catch (e) {
        return { error: true, message: e.message };
    }
}

// Server
http.createServer(async (req, res) => {
    if (req.url === '/funding' && req.method === 'GET') {
        const data = await getAllData();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
}).listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}/funding`);
});
