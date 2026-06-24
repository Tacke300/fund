const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 4000;

// Biến lưu trữ IP thật của Bot (Mặc định nếu lỗi mạng sẽ hiển thị thông báo)
let BOT_PUBLIC_IP = "Đang tải IP...";

// Hàm tự động lấy IPv4 thật của Bot/Server khi khởi động
async function fetchBotIP() {
    try {
        // Sử dụng dynamic import cho node-fetch hoặc dùng thẳng HTTPS module có sẵn của nhóm core để đỡ phải cài thêm thư viện
        const https = require('https');
        https.get('https://api.ipify.org?format=json', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    // Kiểm tra nếu đúng đầu 171 thì lấy, không thì giữ định dạng hoặc báo lỗi tùy nhu cầu
                    BOT_PUBLIC_IP = parsed.ip;
                    console.log(`[HỆ THỐNG] Đã lấy thành công IP thật của Bot: ${BOT_PUBLIC_IP}`);
                } catch (e) {
                    BOT_PUBLIC_IP = "171.x.x.x (Lỗi giải mã IP)";
                }
            });
        }).on('error', (err) => {
            console.error("Không thể lấy IP thật từ api.ipify.org:", err.message);
            BOT_PUBLIC_IP = "171.x.x.x (Lỗi kết nối mạng)";
        });
    } catch (error) {
        BOT_PUBLIC_IP = "171.x.x.x (Lỗi hệ thống)";
    }
}
// Chạy hàm lấy IP ngay khi chạy server
fetchBotIP();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname)));

const USER_DIR = path.join(__dirname, 'user');
if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR);
}

const getUserConfigPath = (username) => path.join(USER_DIR, username, `${username}.json`);

// --- CÁC ENDPOINT API ---

// API mới: Trả về IP thật của Bot cho giao diện Frontend hiển thị
app.get('/api/bot-ip', (req, res) => {
    return res.json({ ip: BOT_PUBLIC_IP });
});

// 1. API ĐĂNG KÝ (Chỉ lưu Binance, lưu dạng Text thường vào /user/username/username.json)
app.post('/api/register', (req, requireResponse) => {
    const { username, email, password, binanceApiKey, binanceSecret } = req.body;

    if (!username || !email || !password) {
        return requireResponse.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ thông tin!' });
    }

    const userSpecificDir = path.join(USER_DIR, username);
    if (fs.existsSync(userSpecificDir)) {
        return requireResponse.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    try {
        fs.mkdirSync(userSpecificDir, { recursive: true });

        // Cấu trúc lưu trữ dạng TEXT không mã hóa theo yêu cầu
        const defaultConfig = {
            username,
            email,
            password, 
            binance: { 
                apiKey: binanceApiKey || "", 
                secret: binanceSecret || "" 
            }
        };

        fs.writeFileSync(getUserConfigPath(username), JSON.stringify(defaultConfig, null, 4), 'utf8');
        return requireResponse.json({ success: true, message: 'Đăng ký thành công!' });
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Lỗi hệ thống khi tạo user.' });
    }
});

// 2. API ĐĂNG NHẬP
app.post('/api/login', (req, requireResponse) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return requireResponse.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu!' });
    }

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) {
        return requireResponse.status(400).json({ success: false, message: 'Tài khoản không tồn tại!' });
    }

    try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        if (configData.password === password) {
            const { password, ...safeData } = configData;
            return requireResponse.json({ success: true, message: 'Đăng nhập thành công!', user: safeData });
        } else {
            return requireResponse.status(400).json({ success: false, message: 'Mật khẩu không chính xác!' });
        }
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Lỗi đọc dữ liệu hệ thống.' });
    }
});

app.listen(PORT, () => {
    console.log(`=== LUFFY CAFE CRYPTO SERVER RUNNING AT http://localhost:${PORT} ===`);
});
