// seversp.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const botEngine = require('./botsp');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 2026;
const DB_PATH = path.join(__dirname, 'data', 'database.json');

fs.ensureDirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(DB_PATH)) fs.writeJsonSync(DB_PATH, []);

app.use(express.static(__dirname));

app.get('/api/stats', async (req, res) => {
    try {
        const data = await fs.readJson(DB_PATH);
        res.json({ total: data.length, history: data.slice(-10).reverse() });
    } catch { res.json({ total: 0, history: [] }); }
});

io.on('connection', (socket) => {
    console.log('UI Connected:', socket.id);

    socket.on('cmd-login', async (creds) => {
        const ok = await botEngine.loginShopee(creds, io);
        socket.emit(ok ? 'login-success' : 'login-fail');
    });

    socket.on('cmd-start', () => {
        botEngine.startLoop(io, DB_PATH);
    });

    socket.on('cmd-stop', () => {
        botEngine.stopLoop(io);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server: http://localhost:${PORT}`);
});
