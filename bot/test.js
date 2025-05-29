// test.js - Node.js ES module, chạy server express đơn giản

import express from 'express';
import dotenv from 'dotenv';

// Load biến môi trường từ .env
dotenv.config();

const app = express();

const PORT = process.env.PORT || 3334;

// Kiểm tra API key
if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
  console.error('❌ Missing Binance API_KEY or API_SECRET in .env');
  process.exit(1);
}

app.get('/api/leverage', (req, res) => {
  // Ví dụ trả lỗi vì key thiếu hoặc giả sử trả json test
  res.json({ leverage: "This is just a test response" });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
