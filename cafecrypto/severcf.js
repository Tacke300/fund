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

// Hàm định tuyến chính xác đến Port của cả 3 lõi Bot
const getBotTargetUrl = (botId, direction) => {
    if (botId === 1) { // Bot Mini
        return direction === 'reverse' ? 'http://127.0.0.1:1832' : 'http://127.0.0.1:1831';
    } else if (botId === 2) { // Bot Pro
        return direction === 'reverse' ? 'http://127.0.0.1:1834' : 'http://127.0.0.1:1833';
    } else { // Bot 3: GRID & DCA
        return 'http://127.0.0.1:1835';
    }
};

// 1. API ĐĂNG KÝ TÀI KHOẢN (Bổ sung cấu hình mặc định cho Bot 3)
app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Thiếu thông tin!' });
    
    const userSpecificDir = path.join(USER_DIR, username);
    if (fs.existsSync(userSpecificDir)) return res.status(400).json({ success: false, message: 'Tài khoản tồn tại!' });
    
    fs.mkdirSync(userSpecificDir);
    const initialConfig = {
        username, email, password,
        binance: { apiKey: '', secret: '' },
        botMini_normal: { isRunning: false, maxPositions: 3, invValue: "1%", posTP: 10, posSL: 10 },
        botMini_reverse: { isRunning: false, maxPositions: 3, invValue: "1%", posTP: 10, posSL: 10 },
        botPro_normal: { isRunning: false, maxPositions: 5, invValue: "2%", posTP: 20, posSL: 8 },
        botPro_reverse: { isRunning: false, maxPositions: 5, invValue: "2%", posTP: 20, posSL: 8 },
        // Cấu hình chuẩn theo thuật toán của file test5.js cho Bot 3
        botGridDca: { isRunning: false, maxPositions: 3, invValue: "1%", gridStepPercent: 1.0, heSoDCA: 1, tpPercent: 1.0, minVol: 7 }
    };
    fs.writeFileSync(getUserConfigPath(username), JSON.stringify(initialConfig, null, 4), 'utf8');
    return res.json({ success: true, message: 'Đăng ký thành công!' });
});

// 2. API ĐĂNG NHẬP
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(400).json({ success: false, message: 'Sai tài khoản!' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.password !== password) return res.status(400).json({ success: false, message: 'Sai mật khẩu!' });
    return res.json({ success: true, message: 'Đăng nhập thành công!' });
});

// 3. API LƯU API KEY
app.post('/api/save-api', (req, res) => {
    const { username, apiKey, secret } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'Không thấy tài khoản!' });
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.binance = { apiKey, secret };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    return res.json({ success: true, message: 'Cập nhật API Key thành công!' });
});

// 4. API BẬT / TẮT BOT THEO PORT RIÊNG BIỆT
app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning, botId, direction } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, msg: 'User không tồn tại.' });

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let configKey = "";
        if (botId === 1) configKey = `botMini_${direction}`;
        else if (botId === 2) configKey = `botPro_${direction}`;
        else configKey = "botGridDca";
        
        config[configKey].isRunning = isRunning;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');

        const TARGET_URL = getBotTargetUrl(botId, direction);
        const response = await axios.post(`${TARGET_URL}/api/user/toggle`, {
            username,
            apiKey: config.binance.apiKey,
            secretKey: config.binance.secret,
            botSettings: config[configKey],
            direction
        });
        return res.json(response.data);
    } catch (error) {
        return res.json({ success: false, msg: `Lỗi kết nối tới Port của Bot ${botId}` });
    }
});

// 5. API STATUS REALTIME ĐỒNG BỘ THEO TỪNG CỔNG
app.get('/api/my-bot/status', async (req, res) => {
    const { username, botId, direction } = req.query;
    const bId = parseInt(botId || 1);
    const dir = direction || 'normal';
    const configPath = getUserConfigPath(username);

    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    let configKey = "";
    if (bId === 1) configKey = `botMini_${dir}`;
    else if (bId === 2) configKey = `botPro_${dir}`;
    else configKey = "botGridDca";

    try {
        const TARGET_URL = getBotTargetUrl(bId, dir);
        const response = await axios.post(`${TARGET_URL}/api/user/status`, {
            username,
            apiKey: config.binance.apiKey,
            secretKey: config.binance.secret
        });
        return res.json(response.data);
    } catch (error) {
        return res.json({
            botSettings: config[configKey] || { isRunning: false },
            activePositions: [],
            status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] },
            wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" }
        });
    }
});

app.listen(PORT, () => console.log(`🌐 [MASTER SERVER] Đang điều phối hệ thống tại Port: ${PORT}`));
