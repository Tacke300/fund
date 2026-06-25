const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 4000;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

const USER_DIR = path.join(__dirname, 'user');
if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR);

const getUserConfigPath = (username) => path.join(USER_DIR, username, 'config.json');

const getBotTargetUrl = (botId) => {
    if (botId === 1) return 'http://127.0.0.1:1831';
    if (botId === 2) return 'http://127.0.0.1:1832';
    return 'http://127.0.0.1:1835';
};

app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin' });
    
    const userSpecificDir = path.join(USER_DIR, username);
    if (fs.existsSync(userSpecificDir)) return res.status(400).json({ success: false, message: 'Tài khoản tồn tại' });
    
    fs.mkdirSync(userSpecificDir);
    const initialConfig = {
        username, email, password,
        binance: { apiKey: '', secret: '' }
    };
    fs.writeFileSync(getUserConfigPath(username), JSON.stringify(initialConfig, null, 4), 'utf8');
    return res.json({ success: true, message: 'Thành công' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(400).json({ success: false, message: 'Sai tài khoản' });
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.password !== password) return res.status(400).json({ success: false, message: 'Sai mật khẩu' });
    
    return res.json({ success: true, message: 'Thành công' });
});

app.post('/api/save-api', (req, res) => {
    const { username, apiKey, secret } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'Lỗi' });
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.binance = { apiKey, secret };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    return res.json({ success: true, message: 'Cập nhật API Key thành công' });
});

app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning, botId } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false });

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const TARGET_URL = getBotTargetUrl(botId);
        const response = await axios.post(`${TARGET_URL}/api/user/toggle`, {
            username, apiKey: config.binance?.apiKey, secretKey: config.binance?.secret, isRunning
        });
        return res.json(response.data);
    } catch (error) {
        return res.json({ success: false, msg: `Cổng lõi của Bot ${botId} chưa chạy.` });
    }
});

app.get('/api/my-bot/status', async (req, res) => {
    const { username, botId } = req.query;
    const bId = parseInt(botId || 1);
    const configPath = getUserConfigPath(username);

    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    try {
        const TARGET_URL = getBotTargetUrl(bId);
        const response = await axios.post(`${TARGET_URL}/api/user/status`, {
            username, apiKey: config.binance?.apiKey, secretKey: config.binance?.secret
        });
        return res.json(response.data);
    } catch (error) {
        return res.json({
            botSettings: { isRunning: false },
            activePositions: [],
            status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] },
            wallet: { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" }
        });
    }
});

app.listen(PORT, () => console.log(`[MASTER] Port: ${PORT}`));
