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

const getUserConfigPath = (username) => path.join(USER_DIR, username, 'config.json');

// --- ĐĂNG KÝ / ĐĂNG NHẬP ---
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const userPath = path.join(USER_DIR, username);
    if (fs.existsSync(userPath)) return res.status(400).json({ success: false, msg: 'User tồn tại' });
    fs.mkdirSync(userPath);
    fs.writeFileSync(path.join(userPath, 'config.json'), JSON.stringify({ username, password, api: {}, runningBots: {} }));
    res.json({ success: true });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const pathConf = getUserConfigPath(username);
    if (!fs.existsSync(pathConf)) return res.status(400).json({ success: false });
    res.json({ success: true });
});

// --- LẤY LOG TỪNG USER ---
app.get('/api/user/logs', async (req, res) => {
    const { username, botId } = req.query;
    const port = botId == 1 ? 1840 : (botId == 2 ? 1841 : 1842);
    try {
        const response = await axios.get(`http://127.0.0.1:${port}/api/logs?username=${username}`);
        res.json(response.data);
    } catch (e) { res.json({ logs: ["Bot chưa khởi động hoặc lỗi kết nối."] }); }
});

// --- TOGGLE BOT (GHI TRẠNG THÁI VÀO CONFIG) ---
app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning, botId } = req.body;
    const pathConf = getUserConfigPath(username);
    const config = JSON.parse(fs.readFileSync(pathConf, 'utf8'));
    
    config.runningBots[botId] = isRunning;
    fs.writeFileSync(pathConf, JSON.stringify(config, null, 4));

    const port = botId == 1 ? 1840 : (botId == 2 ? 1841 : 1842);
    try {
        await axios.post(`http://127.0.0.1:${port}/api/toggle`, { username, isRunning });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: "Bot service chưa chạy trên PM2" }); }
});

app.listen(4000, () => console.log('Master Server running on 4000'));
