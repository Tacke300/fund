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

// --- HÀM TỰ ĐỘNG LẤY ĐÚNG IPV4 THẬT CỦA MÁY CHẠY BOT ---
let botRealPublicIp = 'Đang quét IP...';

async function updateBotIp() {
    try {
        const res = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        if (res.data && res.data.ip) {
            botRealPublicIp = res.data.ip;
            console.log(`[HỆ THỐNG] IPv4 Public đã được xác thực: ${botRealPublicIp}`);
        }
    } catch (e) {
        console.log(`[HỆ THỐNG] Lỗi mạng khi lấy IP, đang dùng dự phòng...`);
        try {
            const backupRes = await axios.get('https://ipv4.icanhazip.com/', { timeout: 5000 });
            if (backupRes.data) {
                botRealPublicIp = backupRes.data.toString().trim();
                console.log(`[HỆ THỐNG] IPv4 (Dự phòng) đã được xác thực: ${botRealPublicIp}`);
            }
        } catch (err) {
            botRealPublicIp = 'Không lấy được IP';
        }
    }
}
updateBotIp();
setInterval(updateBotIp, 3600000); 

const getBotTargetUrl = (botId) => {
    if (botId === 1) return 'http://127.0.0.1:1831'; 
    if (botId === 2) return 'http://127.0.0.1:1833'; // Sửa lại trỏ về cổng đầu tiên của cụm Pro
    return 'http://127.0.0.1:1835'; 
};

app.post('/api/register', (req, res) => { /* Xử lý đăng ký (Code cũ của bạn) */ });
app.post('/api/login', (req, res) => { /* Xử lý đăng nhập (Code cũ của bạn) */ });

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
        
        // Gọi xuống Bot để cập nhật trạng thái
        const response = await axios.post(`${TARGET_URL}/api/user/toggle`, {
            username, apiKey: config.binance?.apiKey, secretKey: config.binance?.secret, isRunning
        }, { timeout: 3000 });
        
        return res.json(response.data);
    } catch (error) {
        console.error(`Lỗi Toggle Bot ${botId}: ${error.message}`);
        return res.json({ success: false, msg: `Cổng lõi của Bot ${botId} chưa khởi chạy.` });
    }
});

// THÊM API RIÊNG CHỈ ĐỂ CHECK SỐ DƯ VÍ LIÊN TỤC
app.get('/api/wallet-balance', async (req, res) => {
    const { username } = req.query;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.json({ hasAPI: false });
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.binance || !config.binance.apiKey) return res.json({ hasAPI: false });

    try {
        // Mượn tạm 1 cổng bot đang mở để gọi hàm check ví (VD: Port 1835)
        const response = await axios.post(`http://127.0.0.1:1835/api/user/status`, {
            username, apiKey: config.binance.apiKey, secretKey: config.binance.secret
        }, { timeout: 2000 });
        
        if (response.data && response.data.wallet) {
            return res.json({
                hasAPI: true,
                wallet: response.data.wallet
            });
        }
    } catch (e) {
        // Nếu Bot 3 sập, thử chuyển sang Bot 1
         try {
            const response2 = await axios.post(`http://127.0.0.1:1831/api/user/status`, {
                username, apiKey: config.binance.apiKey, secretKey: config.binance.secret
            }, { timeout: 2000 });
             if (response2.data && response2.data.wallet) return res.json({ hasAPI: true, wallet: response2.data.wallet });
         } catch(err){}
    }
    return res.json({ hasAPI: false });
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
        }, { timeout: 2000 });
        
        const responseData = response.data;
        responseData.botIp = botRealPublicIp; 
        
        return res.json(responseData);
    } catch (error) {
        return res.json({
            botIp: botRealPublicIp, 
            botSettings: { isRunning: false },
            activePositions: [],
            status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] }
        });
    }
});

app.listen(PORT, () => console.log(`🌐 [MASTER SERVER] Đang điều phối tại Port: ${PORT}`));
