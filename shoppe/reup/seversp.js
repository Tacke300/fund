// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const botEngine = require('./bot'); // File bot logic

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 2026;

// Setup Middleware
app.use(express.static('public'));
app.use(bodyParser.json());

// Khởi tạo database nếu chưa có
const DB_PATH = path.join(__dirname, 'data', 'database.json');
if (!fs.existsSync(DB_PATH)) {
    fs.ensureDirSync(path.join(__dirname, 'data'));
    fs.writeJsonSync(DB_PATH, []);
}

// API: Lấy thống kê
app.get('/api/stats', async (req, res) => {
    try {
        const data = await fs.readJson(DB_PATH);
        const today = new Date().toLocaleDateString('vi-VN');
        
        const stats = {
            today: data.filter(d => d.date === today).length,
            week: data.length, // Demo logic (cần xử lý date kỹ hơn cho tuần/tháng)
            month: data.length,
            total: data.length,
            history: data.reverse() // Mới nhất lên đầu
        };
        res.json(stats);
    } catch (e) {
        res.json({ error: true });
    }
});

// Socket.io connection
io.on('connection', (socket) => {
    console.log('Client connected UI');

    // Nhận lệnh Start từ UI
    socket.on('start-bot', (credentials) => {
        io.emit('log', { type: 'info', msg: '🚀 Đang khởi động Bot...' });
        
        // Gọi bot chạy
        botEngine.start(credentials, io, DB_PATH);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
