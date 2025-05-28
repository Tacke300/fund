const crypto = require('crypto');
const https = require('https');

const apiKey = 'ynfUQ5PxqqWQJdwPsAVREudagiF1WEN3HAENgLZIwWC3VrsNnT74wlRwY29hGXZky';
const apiSecret = 'pYTcusasHde67ajzvaOmgmSReqbZ7f0j2uwfR3VaeHai1emhuWRcacmlBCnrRglH';

function getSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function callFuturesAccount() {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;

  const signature = getSignature(queryString, apiSecret);

  const path = `/fapi/v2/account?${queryString}&signature=${signature}`;

  const options = {
    hostname: 'fapi.binance.com',
    path: path,
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': apiKey
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('Futures account info:', JSON.parse(data));
      } else {
        console.error('API lỗi:', res.statusCode, data);
      }
    });
  });

  req.on('error', (e) => {
    console.error('Lỗi request:', e);
  });

  req.end();
}

callFuturesAccount();
