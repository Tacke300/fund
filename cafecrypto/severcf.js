const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 4000;
const BOT_CORE_URL = 'http://127.0.0.1:8080';

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

const USER_DIR = path.join(__dirname, 'user');
if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR);
}

// Helper lấy đường dẫn cấu hình
const getUserConfigPath = (username) => path.join(USER_DIR, username, 'config.json');

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
        username,
        email,
        password,
        binance: { apiKey: '', secret: '' },
        botSettings: {
            isRunning: false,
            dcaTypeThuong: 'DUONG',
            dcaTypeDianguc: 'AM',
            maxPositions: 3,
            invValue: "1%",
            minVol: 7,
            posTP: 10,
            posSL: 10.0,
            dianguctp: 30,
            diangucsl: 10,
            diangucdca: 10,
            posdca: 3,
            diangucvol: 15,
            heSoThuong: 2,
            heSoDianguc: 3
        }
    };

    fs.writeFileSync(getUserConfigPath(username), JSON.stringify(initialConfig, null, 4), 'utf8');
    return res.json({ success: true, message: 'Đăng ký tài khoản thành công!' });
});

// 2. API ĐĂNG NHẬP
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const configPath = getUserConfigPath(username);

    if (!fs.existsSync(configPath)) {
        return res.status(400).json({ success: false, message: 'Tài khoản không tồn tại!' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.password !== password) {
            return res.status(400).json({ success: false, message: 'Mật khẩu không chính xác!' });
        }
        return res.json({ success: true, message: 'Đăng nhập thành công!' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Lỗi xử lý dữ liệu hệ thống.' });
    }
});

// 3. API CẬP NHẬT CẤU HÌNH API KEY BINANCE
app.post('/api/save-api', (req, res) => {
    const { username, apiKey, secret } = req.body;
    const configPath = getUserConfigPath(username);

    if (!fs.existsSync(configPath)) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy tài khoản!' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.binance = { apiKey, secret };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
        return res.json({ success: true, message: 'Lưu API Binance thành công!' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Không thể ghi tệp cấu hình.' });
    }
});

// 4. API PROXY: BẬT / TẮT BOT CHO TỪNG USER CỤ THỂ
app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning } = req.body;
    const configPath = getUserConfigPath(username);

    if (!fs.existsSync(configPath)) {
        return res.status(404).json({ success: false, message: 'User không tồn tại.' });
    }

    try {
        // Cập nhật trạng thái vào file config.json của user trước
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.botSettings.isRunning = isRunning;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');

        // Bắn tín hiệu sang Core Bot Engine (Cổng 8080) để nạp dữ liệu chạy/dừng
        const endpoint = isRunning ? '/api/user/start' : '/api/user/stop';
        const response = await axios.post(`${BOT_CORE_URL}${endpoint}`, {
            username,
            apiKey: config.binance.apiKey,
            secretKey: config.binance.secret,
            botSettings: config.botSettings
        });

        return res.json(response.data);
    } catch (error) {
        return res.json({ success: false, msg: "Không kết nối được với Core Bot ngầm ở cổng 8080." });
    }
});

// 5. API PROXY: LẤY TRẠNG THÁI REALTIME VÀ THÔNG TIN SỐ DƯ TỪ CORE BOT CỦA TỪNG USER
app.get('/api/my-bot/status', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, msg: "Thiếu tham số username" });

    try {
        const response = await axios.get(`${BOT_CORE_URL}/api/user/status/${username}`);
        return res.json(response.data);
    } catch (error) {
        // Nếu bot chưa chạy hoặc cổng 8080 chết, lấy tạm thông tin mặc định trong config
        const configPath = getUserConfigPath(username);
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return res.json({
                botSettings: config.botSettings,
                activePositions: [],
                status: { botClosedCount: 0, botPnLClosed: 0, botLogs: [] },
                wallet: { totalWalletBalance: "0.00", availableBalance: "0.00" }
            });
        }
        return res.status(500).json({ success: false, msg: "Lỗi kết nối đồng bộ cơ sở dữ liệu." });
    }
});

app.listen(PORT, () => console.log(`🌐 [MASTER CONTROL SERVER] Hệ thống đang hoạt động tại cổng công khai: ${PORT}`));
