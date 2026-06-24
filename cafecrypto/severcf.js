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

// Lấy cổng nội bộ dựa trên loại Bot
const getBotTargetUrl = (botId) => {
    return botId === 2 ? 'http://127.0.0.1:1832' : 'http://127.0.0.1:1831';
};

// 1. API ĐĂNG KÝ TÀI KHOẢN
app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ thông tin!' });
    }
    const userSpecificDir = path.join(USER_DIR, username);
    if (fs.existsSync(userSpecificDir)) {
        return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }
    fs.mkdirSync(userSpecificDir);
    const initialConfig = {
        username, email, password,
        binance: { apiKey: '', secret: '' },
        bot1Settings: { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10 },
        bot2Settings: { isRunning: false, maxPositions: 5, invValue: "2%", minVol: 15, posTP: 20, posSL: 8 }
    };
    fs.writeFileSync(getUserConfigPath(username), JSON.stringify(initialConfig, null, 4), 'utf8');
    return res.json({ success: true, message: 'Đăng ký tài khoản thành công!' });
});

// 2. API ĐĂNG NHẬP
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(400).json({ success: false, message: 'Tài khoản không tồn tại!' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.password !== password) return res.status(400).json({ success: false, message: 'Mật khẩu không chính xác!' });
    return res.json({ success: true, message: 'Đăng nhập thành công!' });
});

// 3. API LƯU CONFIG API KEY
app.post('/api/save-api', (req, res) => {
    const { username, apiKey, secret } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.binance = { apiKey, secret };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    return res.json({ success: true, message: 'Lưu cấu hình API Binance thành công!' });
});

// 4. API PROXY: BẬT / TẮT BOT (Hỗ trợ cả Bot 1 & Bot 2)
app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning, botId } = req.body; // botId: 1 hoặc 2
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, msg: 'User không tồn tại.' });

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const settingKey = botId === 2 ? 'bot2Settings' : 'bot1Settings';
        config[settingKey].isRunning = isRunning;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');

        const TARGET_URL = getBotTargetUrl(botId);
        const response = await axios.post(`${TARGET_URL}/api/user/toggle`, {
            username,
            apiKey: config.binance.apiKey,
            secretKey: config.binance.secret,
            botSettings: config[settingKey],
            botId
        });
        return res.json(response.data);
    } catch (error) {
        return res.json({ success: false, msg: `Thất bại khi kết nối lõi Bot ${botId}` });
    }
});

// 5. API PROXY: LẤY SỐ DƯ THẬT VÀ TRẠNG THÁI REALTIME
app.get('/api/my-bot/status', async (req, res) => {
    const { username, botId } = req.query;
    const bId = parseInt(botId || 1);
    const configPath = getUserConfigPath(username);

    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    try {
        const TARGET_URL = getBotTargetUrl(bId);
        // Gọi xuống cổng bot tương ứng để lấy dữ liệu thời gian thực kèm số dư ví thật
        const response = await axios.post(`${TARGET_URL}/api/user/status`, {
            username,
            apiKey: config.binance.apiKey,
            secretKey: config.binance.secret,
            botId: bId
        });
        return res.json(response.data);
    } catch (error) {
        // Trả về dữ liệu trống nếu bot chưa được khởi tạo ở backend
        const settingKey = bId === 2 ? 'bot2Settings' : 'bot1Settings';
        return res.json({
            botSettings: config[settingKey] || { isRunning: false },
            activePositions: [],
            status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] },
            wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" }
        });
    }
});

app.listen(PORT, () => console.log(`🌐 [MASTER SERVER] Đang phân phối giao diện điều khiển tại Port: ${PORT}`));
