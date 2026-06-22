const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(cors());
// Phục vụ các file tĩnh ngay tại thư mục gốc
app.use(express.static(path.join(__dirname)));

const USER_DIR = path.join(__dirname, 'user');

// Đảm bảo thư mục 'user' tồn tại khi khởi chạy server
if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR);
}

// Helper: Lấy đường dẫn file cấu hình của user
const getUserConfigPath = (username) => path.join(USER_DIR, username, 'config.json');
const getUserHistoryPath = (username) => path.join(USER_DIR, username, 'config_history.json');

// 1. API ĐĂNG KÝ
app.post('/api/register', (req, requireResponse) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return requireResponse.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ thông tin!' });
    }

    const userSpecificDir = path.join(USER_DIR, username);
    
    // Kiểm tra user đã tồn tại chưa
    if (fs.existsSync(userSpecificDir)) {
        return requireResponse.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    try {
        // Tạo thư mục user/<username>/
        fs.mkdirSync(userSpecificDir, { recursive: true });

        // Cấu trúc file config mặc định
        const defaultConfig = {
            username,
            email,
            password, // Lưu text thường theo yêu cầu
            binance: { apiKey: "", secret: "" },
            kucoin: { apiKey: "", secret: "", passphrase: "" }
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
            // Trả về data không kèm password để bảo mật client
            const { password, ...safeData } = configData;
            return requireResponse.json({ success: true, message: 'Đăng nhập thành công!', user: safeData });
        } else {
            return requireResponse.status(400).json({ success: false, message: 'Mật khẩu không chính xác!' });
        }
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Lỗi đọc dữ liệu hệ thống.' });
    }
});

// 3. API LẤY CẤU HÌNH USER
app.get('/api/user-config', (req, requireResponse) => {
    const { username } = req.query;
    if (!username) return requireResponse.status(400).json({ success: false, message: 'Thiếu username!' });

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return requireResponse.status(404).json({ success: false, message: 'Không tìm thấy cấu hình!' });

    try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const { password, ...safeData } = configData;
        return requireResponse.json({ success: true, data: safeData });
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Lỗi đọc cấu hình.' });
    }
});

// 4. API LƯU CẤU HÌNH & GHI LỊCH SỬ (HISTORY)
app.post('/api/save-config', (req, requireResponse) => {
    const { username, binance, kucoin } = req.body;
    if (!username) return requireResponse.status(400).json({ success: false, message: 'Thiếu username!' });

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return requireResponse.status(404).json({ success: false, message: 'User không tồn tại!' });

    try {
        const oldConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        // Giữ nguyên dữ liệu cũ (bao gồm password, email) và cập nhật API mới nếu có điền
        const newConfig = {
            ...oldConfig,
            binance: {
                apiKey: binance.apiKey !== undefined ? binance.apiKey : oldConfig.binance.apiKey,
                secret: binance.secret !== undefined ? binance.secret : oldConfig.binance.secret
            },
            kucoin: {
                apiKey: kucoin.apiKey !== undefined ? kucoin.apiKey : oldConfig.kucoin.apiKey,
                secret: kucoin.secret !== undefined ? kucoin.secret : oldConfig.kucoin.secret,
                passphrase: kucoin.passphrase !== undefined ? kucoin.passphrase : oldConfig.kucoin.passphrase
            }
        };

        // Ghi file config mới
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 4), 'utf8');

        // Xử lý ghi lịch sử (History)
        const historyPath = getUserHistoryPath(username);
        let historyData = [];

        if (fs.existsSync(historyPath)) {
            try {
                historyData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            } catch (e) { historyData = []; }
        }

        // Bản sao an toàn để ghi log (ẩn password)
        const safeOld = { binance: oldConfig.binance, kucoin: oldConfig.kucoin };
        const safeNew = { binance: newConfig.binance, kucoin: newConfig.kucoin };

        historyData.push({
            time: new Date().toISOString(),
            old: safeOld,
            new: safeNew
        });

        fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 4), 'utf8');

        return requireResponse.json({ success: true, message: 'Cấu hình đã được cập nhật thành công!' });
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Không thể lưu cấu hình.' });
    }
});

// 5. API LẤY SỐ DƯ VÍ (MOCK DATA HOẶC XỬ LÝ NẾU CÓ API)
app.get('/api/wallet-balance', (req, requireResponse) => {
    const { username } = req.query;
    if (!username) return requireResponse.status(400).json({ success: false, message: 'Thiếu username!' });

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return requireResponse.status(404).json({ success: false, message: 'Không thấy thông tin thành viên.' });

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        const hasBinance = config.binance && config.binance.apiKey && config.binance.secret;
        const hasKucoin = config.kucoin && config.kucoin.apiKey && config.kucoin.secret && config.kucoin.passphrase;

        if (!hasBinance && !hasKucoin) {
            return requireResponse.json({ hasAPI: false });
        }

        // Mock dữ liệu Futures USDT khi có cấu hình API như thật
        const binanceBalance = hasBinance ? (Math.random() * 5000 + 1500).toFixed(2) : "0.00";
        const kucoinBalance = hasKucoin ? (Math.random() * 3000 + 500).toFixed(2) : "0.00";
        const totalBalance = (parseFloat(binanceBalance) + parseFloat(kucoinBalance)).toFixed(2);

        return requireResponse.json({
            hasAPI: true,
            binanceBalance,
            kucoinBalance,
            totalBalance
        });
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Lỗi tải dữ liệu số dư.' });
    }
});

// 6. API LẤY TRẠNG THÁI BOT (MOCK FRAMEWORK)
app.get('/api/status', (req, requireResponse) => {
    return requireResponse.json({
        status: "Stopped",
        position: [],
        orders: [],
        pnl: "0.00",
        logs: ["Bot initialized. Waiting for start command..."]
    });
});

// Khởi chạy máy chủ
app.listen(PORT, () => {
    console.log(`=== LUFFY CAFE CRYPTO SERVER RUNNING AT http://localhost:${PORT} ===`);
});
