import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config(); // Tải biến môi trường từ .env

const app = express();
const port = 3333;

const APIKEY = process.env.BINANCE_API_KEY;
const APISECRET = process.env.BINANCE_API_SECRET;

// ==== Ký HMAC SHA256 ====
function sign(queryString) {
  return crypto.createHmac('sha256', APISECRET).update(queryString).digest('hex');
}

// ==== Lấy server time từ Binance ====
async function getServerTime() {
  const url = 'https://fapi.binance.com/fapi/v1/time';
  const res = await fetch(url);
  const text = await res.text();

  try {
    return JSON.parse(text).serverTime;
  } catch (err) {
    console.error("Không thể parse JSON, có thể bị trả về HTML:", text);
    throw err;
  }
}

// ==== Gọi API Binance đã ký ====
async function binanceSignedRequest(endpoint, params = {}) {
  const timestamp = await getServerTime();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(query);
  const url = `https://fapi.binance.com${endpoint}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': APIKEY }
  });

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("Phản hồi không phải JSON:", text);
    throw new Error(`Lỗi API Binance: ${res.status} - ${text}`);
  }
}

// ==== Lấy leverage các cặp USDT-M ====
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

// ==== Endpoint test server time ====
app.get('/api/time', async (req, res) => {
  try {
    const serverTime = await getServerTime();
    res.json({ serverTime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
