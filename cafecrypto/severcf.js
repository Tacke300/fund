const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = 4000;

let BOT_PUBLIC_IP = "Đang tải IP...";

// Tự động lấy IPv4 thật của Bot/Server khi khởi chạy
function fetchBotIP() {
    https.get('https://api.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                BOT_PUBLIC_IP = parsed.ip;
                console.log(`[SERVER] Đã xác định IP thật của BOT: ${BOT_PUBLIC_IP}`);
            } catch (e) {
                BOT_PUBLIC_IP = "171.x.x.x (Lỗi đọc IP)";
            }
        });
    }).on('error', (err) => {
        console.error("Lỗi kết nối lấy IP thật:", err.message);
        BOT_PUBLIC_IP = "171.x.x.x (Lỗi kết nối mạng)";
    });
}
fetchBotIP();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

const USER_DIR = path.join(__dirname, 'user');
if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR);
}

// Đường dẫn file cấu hình của user: /user/tên_user/tên_user.json
const getUserConfigPath = (username) => path.join(USER_DIR, username, `${username}.json`);

// Tuyến mặc định: Người dùng truy cập trang chủ
app.get('/', (req, res) => {
    // Trả về file login.html (Bên trong login.html có script tự check nếu login rồi sẽ nhảy thẳng index.html)
    res.sendFile(path.join(__dirname, 'login.html'));
});

// API lấy IP thật của Bot
app.get('/api/bot-ip', (req, res) => {
    return res.json({ ip: BOT_PUBLIC_IP });
});

// API ĐĂNG KÝ (Lưu text thường vào /user/username/username.json)
app.post('/api/register', (req, res) => {
    const { username, email, password, binanceApiKey, binanceSecret } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ thông tin!' });
    }

    const userSpecificDir = path.join(USER_DIR, username);
    if (fs.existsSync(userSpecificDir)) {
        return res.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    try {
        fs.mkdirSync(userSpecificDir, { recursive: true });

        const userAccountData = {
            username,
            email,
            password, 
            binance: { 
                apiKey: binanceApiKey || "", 
                secret: binanceSecret || "" 
            }
        };

        fs.writeFileSync(getUserConfigPath(username), JSON.stringify(userAccountData, null, 4), 'utf8');
        return res.json({ success: true, message: 'Đăng ký thành công!' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Lỗi hệ thống khi tạo user.' });
    }
});

// API ĐĂNG NHẬP
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu!' });
    }

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) {
        return res.status(400).json({ success: false, message: 'Tài khoản không tồn tại!' });
    }

    try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        if (configData.password === password) {
            const { password, ...safeData } = configData;
            return res.json({ success: true, message: 'Đăng nhập thành công!', user: safeData });
        } else {
            return res.status(400).json({ success: false, message: 'Mật khẩu không chính xác!' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Lỗi đọc dữ liệu hệ thống.' });
    }
});

// Các API bổ trợ giữ nguyên phục vụ cho file index.html gốc của ông
app.get('/api/user-config', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Thiếu username!' });

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'Không tìm thấy cấu hình!' });

    try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const { password, ...safeData } = configData;
        return res.json({ success: true, data: safeData });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Lỗi đọc cấu hình.' });
    }
});

// Giữ lại API Mock Balance phòng khi code index.html của ông gọi tới
app.get('/api/wallet-balance', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Thiếu username!' });

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'Không tìm thấy user.' });

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const hasBinance = config.binance && config.binance.apiKey && config.binance.secret;

        if (!hasBinance) return res.json({ hasAPI: false });

        const binanceBalance = (Math.random() * 5000 + 1500).toFixed(2);
        return res.json({
            hasAPI: true,
            binanceBalance,
            totalBalance: binanceBalance
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Lỗi tải số dư.' });
    }
});

app.listen(PORT, () => {
    console.log(`=== LUFFY CAFE CRYPTO SERVER RUNNING AT http://localhost:${PORT} ===`);
});
