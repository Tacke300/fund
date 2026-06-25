const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios'); // Thêm axios để forward lệnh xuống các core bot

const app = express();
const PORT = 4000;

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

// 1. API ĐĂNG KÝ (Giữ nguyên gốc)
app.post('/api/register', (req, requireResponse) => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return requireResponse.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ thông tin!' });
    }

    const userSpecificDir = path.join(USER_DIR, username);
    
    if (fs.existsSync(userSpecificDir)) {
        return requireResponse.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    try {
        fs.mkdirSync(userSpecificDir, { recursive: true });

        const defaultConfig = {
            username,
            email,
            password, 
            binance: { apiKey: "", secret: "" },
            kucoin: { apiKey: "", secret: "", passphrase: "" },
            // Khởi tạo trạng thái cho các gói bot mới
            bots: { mini: false, pro: false, griddca: false }
        };

        fs.writeFileSync(getUserConfigPath(username), JSON.stringify(defaultConfig, null, 4), 'utf8');
        return requireResponse.json({ success: true, message: 'Đăng ký thành công!' });
    } catch (error) {
        return requireResponse.status(500).json({ success: false, message: 'Lỗi hệ thống khi tạo user.' });
    }
});

// 2. API ĐĂNG NHẬP (Giữ nguyên gốc)
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

// 3. API LẤY CẤU HÌNH USER (Giữ nguyên gốc)
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

// 4. API LƯU CẤU HÌNH & GHI LỊCH SỬ (Giữ nguyên gốc)
app.post('/api/save-config', (req, requireResponse) => {
    const { username, binance, kucoin } = req.body;
    if (!username) return requireResponse.status(400).json({ success: false, message: 'Thiếu username!' });

    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return requireResponse.status(404).json({ success: false, message: 'User không tồn tại!' });

    try {
        const oldConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
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

        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 4), 'utf8');

        const historyPath = getUserHistoryPath(username);
        let historyData = [];

        if (fs.existsSync(historyPath)) {
            try {
                historyData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            } catch (e) { historyData = []; }
        }

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

// 5. API LẤY SỐ DƯ VÍ (Giữ nguyên gốc cấu trúc)
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

// ================= NÂNG CẤP LUỒNG ĐIỀU KHIỂN BOT TRUNG TÂM =================

// 6. API TOGGLE: 1 PHÁT CHẠY CẢ 2 PORT HOẶC PORT CHUYÊN BIỆT
app.post('/api/bot/toggle', async (req, res) => {
    const { username, botId, isRunning } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'User không tồn tại.' });

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.bots) config.bots = { mini: false, pro: false, griddca: false };
        
        config.bots[botId] = isRunning;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');

        // Phân phối danh sách port đích
        let targets = [];
        if (botId === 'mini') targets = ['http://127.0.0.1:1831', 'http://127.0.0.1:1832'];
        else if (botId === 'pro') targets = ['http://127.0.0.1:1833', 'http://127.0.0.1:1834'];
        else if (botId === 'griddca') targets = ['http://127.0.0.1:1835'];

        // Phát tín hiệu song song, bọc catch độc lập từng port để không lo crash chéo
        await Promise.all(targets.map(target => {
            return axios.post(`${target}/api/user/toggle`, {
                username,
                apiKey: config.binance?.apiKey,
                secretKey: config.binance?.secret,
                isRunning
            }).catch(() => { /* Cô lập lỗi kết nối nếu port đó chưa online */ });
        }));

        return res.json({ success: true, isRunning });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// 7. API STATUS TỔNG HỢP (Gom vị thế và log của các port thành một gói duy nhất)
app.get('/api/bot/status', async (req, res) => {
    const { username, botId } = req.query;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const isRunning = config.bots?.[botId] || false;

    let targets = [];
    if (botId === 'mini') targets = ['http://127.0.0.1:1831', 'http://127.0.0.1:1832'];
    else if (botId === 'pro') targets = ['http://127.0.0.1:1833', 'http://127.0.0.1:1834'];
    else if (botId === 'griddca') targets = ['http://127.0.0.1:1835'];

    let aggregatedPositions = [];
    let aggregatedLogs = [];

    // Gọi dữ liệu từ các cổng chạy ngầm an toàn
    for (const target of targets) {
        try {
            const response = await axios.post(`${target}/api/user/status`, { username }, { timeout: 800 });
            if (response.data) {
                if (response.data.activePositions) aggregatedPositions.push(...response.data.activePositions);
                if (response.data.status?.botLogs) aggregatedLogs.push(...response.data.status.botLogs);
            }
        } catch (e) {
            // Cổng này chưa bật hoặc lỗi, bỏ qua để lấy dữ liệu từ các cổng khác
        }
    }

    return res.json({
        isRunning,
        positions: aggregatedPositions,
        logs: aggregatedLogs.sort((a, b) => b.time?.localeCompare(a.time)).slice(0, 40)
    });
});

app.listen(PORT, () => {
    console.log(`=== LUFFY CAFE CRYPTO MASTER SERVER RUNNING AT http://localhost:${PORT} ===`);
});
