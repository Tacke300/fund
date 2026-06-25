const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());

const USER_DIR = path.join(__dirname, 'user');
if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR);

// Auth
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const userPath = path.join(USER_DIR, username);
    if (fs.existsSync(userPath)) return res.status(400).json({ msg: 'Tồn tại' });
    fs.mkdirSync(userPath);
    fs.writeFileSync(path.join(userPath, 'config.json'), JSON.stringify({ username, password, api: {} }));
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (fs.existsSync(path.join(USER_DIR, username))) res.json({ success: true });
    else res.status(400).json({ success: false });
});

// Điều phối lệnh cho các Bot con
app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning, botId } = req.body;
    const port = botId == 1 ? 1840 : (botId == 2 ? 1841 : 1842);
    try {
        await axios.post(`http://127.0.0.1:${port}/api/toggle`, { username, isRunning });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: "Bot service chưa chạy trên PM2" }); }
});

app.listen(4000);
