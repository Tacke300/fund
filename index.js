const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

// Serve các file tĩnh trong thư mục "bot"
app.use('/bot', express.static(path.join(__dirname, 'bot')));

// Khởi động server
app.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
