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

// --- HÀM TỰ ĐỘNG LẤY IP PUBLIC THẬT CỦA MÁY CHẠY BOT ---
let botRealPublicIp = 'Đang quét IP...';

async function updateBotIp() {
    try {
        const res = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
        if (res.data && res.data.ip) {
            botRealPublicIp = res.data.ip;
            console.log(`[HỆ THỐNG] IPv4 Public đã được xác thực: ${botRealPublicIp}`);
        }
    } catch (e) {
        console.log(`[HỆ THỐNG] Lỗi mạng khi lấy IP, đang dùng dự phòng...`);
        botRealPublicIp = 'Không lấy được IP (Lỗi mạng)';
    }
}
updateBotIp();
setInterval(updateBotIp, 3600000); // Làm mới mỗi 1 tiếng

// Map Port theo Bot
const getBotTargetUrl = (botId) => {
    if (botId === 1) return 'http://127.0.0.1:1831'; // Mini
    if (botId === 2) return 'http://127.0.0.1:1832'; // Pro
    return 'http://127.0.0.1:1835'; // Grid & DCA
};

// API Cơ bản
app.post('/api/register', (req, res) => { /* Xử lý đăng ký (Code cũ của ông) */ });
app.post('/api/login', (req, res) => { /* Xử lý đăng nhập (Code cũ của ông) */ });
app.post('/api/save-api', (req, res) => {
    const { username, apiKey, secret } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'Lỗi tài khoản' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.binance = { apiKey, secret };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    return res.json({ success: true, message: 'Lưu API thành công!' });
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

// API STATUS TRẢ VỀ KÈM IP THẬT CHO HTML
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
        
        // TRUYỀN IP THẬT LẤY TỪ SERVER XUỐNG FRONTEND
        const responseData = response.data;
        responseData.botIp = botRealPublicIp; 
        
        return res.json(responseData);
    } catch (error) {
        return res.json({
            botIp: botRealPublicIp, // Vẫn trả IP kể cả khi bot lõi chưa bật
            botSettings: { isRunning: false },
            activePositions: [],
            status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] },
            wallet: { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" }
        });
    }
});

app.listen(PORT, () => console.log(`🌐 [MASTER SERVER] Đang điều phối tại Port: ${PORT}`));
