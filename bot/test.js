import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;

if (!apiKey || !apiSecret) {
  console.error('❌ Missing Binance API_KEY or API_SECRET in .env');
  process.exit(1);
}

const BASE_URL = 'https://fapi.binance.com'; // Binance Futures mainnet

// Hàm tạo query string + ký HMAC SHA256
function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Lấy account info (balance, positions...)
async function getAccountInfo() {
  try {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = sign(query, apiSecret);
    const url = `${BASE_URL}/fapi/v2/account?${query}&signature=${signature}`;

    const headers = {
      'X-MBX-APIKEY': apiKey,
    };

    const res = await axios.get(url, { headers });
    console.log('✅ Binance Futures Account Info:', res.data);
  } catch (error) {
    console.error('❌ Error getting account info:');
    if (error.response) {
      console.error(error.response.status, error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

getAccountInfo();
