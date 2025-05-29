import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';

const app = express();
const port = 3000;

// ... các code khác giữ nguyên, chỉ thay require => import

// ==== Binance API Key/Secret (giữ bí mật) ====
const APIKEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const APISECRET = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc';

app.use(express.static('public')); // serve frontend from /public

// ==== HMAC SHA256 ký ====
function sign(queryString) {
  return crypto.createHmac('sha256', APISECRET).update(queryString).digest('hex');
}

// ==== Lấy server time ====
async function getServerTime() {
  const res = await fetch('https://fapi.binance.com/fapi/v1/time');
  const data = await res.json();
  return data.serverTime;
}

// ==== Gọi API Binance có ký ====
async function binanceSignedRequest(endpoint, params = {}) {
  const timestamp = await getServerTime();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(query);
  const url = `https://fapi.binance.com${endpoint}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': APIKEY }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance API error: ${res.status} ${text}`);
  }
  return res.json();
}

// ==== API endpoint lấy leverage các cặp USDT-M ====
app.get('/api/leverage', async (req, res) => {
  try {
    const data = await binanceSignedRequest('/fapi/v1/leverageBracket');
    const result = data.map(item => {
      const maxLev = Math.max(...item.brackets.map(b => b.initialLeverage));
      return { symbol: item.symbol, maxLeverage: maxLev };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
