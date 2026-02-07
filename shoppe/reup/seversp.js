const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const botEngine = require('./bot');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = 2026;

app.use(express.static('public'));
app.use(bodyParser.json());

const DB_PATH = path.join(__dirname, 'data', 'database.json');
fs.ensureDirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(DB_PATH)) fs.writeJsonSync(DB_PATH, []);

// API Lấy thống kê
app.get('/api/stats', async (req, res) => {
    try {
        const data = await fs.readJson(DB_PATH);
        res.json({
            total: data.length,
            history: data.reverse()
        });
    } catch (e) { res.json({ total: 0, history: [] }); }
});

io.on('connection', (socket) => {
    console.log('Client UI connected');

    // 1. Lệnh Đăng nhập
    socket.on('cmd-login', async (creds) => {
        const result = await botEngine.loginShopee(creds, io);
        if (result) {
            socket.emit('login-success');
        } else {
            socket.emit('login-fail');
        }
    });

    // 2. Lệnh Chạy Bot (Start)
    socket.on('cmd-start', () => {
        botEngine.startLoop(io, DB_PATH);
    });

    // 3. Lệnh Dừng Bot (Stop)
    socket.on('cmd-stop', () => {
        botEngine.stopLoop(io);
    });
});



server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
