const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 4000;

// Middleware
app.use(express.json());
app.use(cors());

const USER_DIR = path.join(__dirname, 'user');

// Đảm bảo thư mục 'user' tồn tại khi khởi chạy server
if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR);
}

// Helper: Lấy đường dẫn file cấu hình của user
const getUserConfigPath = (username) => path.join(USER_DIR, username, 'config.json');
const getUserHistoryPath = (username) => path.join(USER_DIR, username, 'config_history.json');

// --- CÁC API BACKEND ---

// 1. API ĐĂNG KÝ (Cập nhật thêm trường API Key lúc đăng ký)
app.post('/api/register', (req, requireResponse) => {
    const { username, email, password, binanceApiKey, binanceSecret, kucoinApiKey, kucoinSecret, kucoinPassphrase } = req.body;

    if (!username || !email || !password) {
        return requireResponse.status(400).json({ success: false, message: 'Vui lòng điền đầy đủ thông tin bắt buộc!' });
    }

    const userSpecificDir = path.join(USER_DIR, username);
    
    // Kiểm tra user đã tồn tại chưa
    if (fs.existsSync(userSpecificDir)) {
        return requireResponse.status(400).json({ success: false, message: 'Tên tài khoản đã tồn tại!' });
    }

    try {
        // Tạo thư mục user/<username>/
        fs.mkdirSync(userSpecificDir, { recursive: true });

        // Cấu trúc file config mặc định + dữ liệu nhập lúc đăng ký (Lưu text thường)
        const defaultConfig = {
            username,
            email,
            password, 
            binance: { 
                apiKey: binanceApiKey || "", 
                secret: binanceSecret || "" 
            },
            kucoin: { 
                apiKey: kucoinApiKey || "", 
                secret: kucoinSecret || "", 
                passphrase: kucoinPassphrase || "" 
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

// 5. API LẤY SỐ DƯ VÍ
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

// 6. API LẤY TRẠNG THÁI BOT
app.get('/api/status', (req, requireResponse) => {
    return requireResponse.json({
        status: "Stopped",
        position: [],
        orders: [],
        pnl: "0.00",
        logs: ["Bot initialized. Waiting for start command..."]
    });
});


// --- TRẢ VỀ GIAO DIỆN HTML TÍCH HỢP ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Luffy Cafe Crypto</title>
    <style>
        :root {
            --bg-color: #0b0e11;
            --card-bg: #181a20;
            --primary: #f0b90b;
            --primary-hover: #c99a09;
            --text-main: #eaecef;
            --text-muted: #848e9c;
            --border-color: #2b3139;
            --error: #f6465d;
            --success: #0ecb81;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background-color: var(--bg-color); color: var(--text-main); display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 15px; }

        /* Auth Container */
        .auth-container { background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 16px; width: 100%; max-width: 460px; padding: 25px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
        
        /* IP Whitelist Warning Section */
        .whitelist-warn {
            display: flex;
            align-items: center;
            gap: 10px;
            background: rgba(246, 70, 93, 0.1);
            border: 1px solid rgba(246, 70, 93, 0.3);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 20px;
            color: var(--error);
            font-size: 13.5px;
            line-height: 1.4;
            font-weight: 600;
        }
        .whitelist-warn .icon { font-size: 20px; }

        .logo-area { text-align: center; margin-bottom: 20px; }
        .logo-area h1 { color: var(--primary); font-size: 24px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
        .logo-area p { color: var(--text-muted); font-size: 13px; margin-top: 5px; }

        .tabs { display: flex; border-bottom: 2px solid var(--border-color); margin-bottom: 20px; }
        .tab-btn { flex: 1; text-align: center; padding: 12px; background: none; border: none; color: var(--text-muted); font-weight: 600; font-size: 15px; cursor: pointer; transition: all 0.3s ease; }
        .tab-btn.active { color: var(--primary); border-bottom: 2px solid var(--primary); margin-bottom: -2px; }

        .form-panel { display: none; }
        .form-panel.active { display: block; }

        .input-group { margin-bottom: 15px; }
        .input-group label { display: block; margin-bottom: 6px; color: var(--text-main); font-size: 13.5px; font-weight: 500; }
        .input-group input { width: 100%; padding: 11px 14px; background-color: var(--bg-color); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-main); font-size: 14.5px; outline: none; transition: border-color 0.2s; }
        .input-group input:focus { border-color: var(--primary); }

        .section-title { font-size: 14px; color: var(--primary); margin: 20px 0 10px 0; border-left: 3px solid var(--primary); padding-left: 8px; font-weight: 600; }

        .remember-box { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; font-size: 13.5px; color: var(--text-muted); cursor: pointer; }
        .remember-box input { width: 16px; height: 16px; accent-color: var(--primary); }

        .btn-submit { width: 100%; padding: 13px; background-color: var(--primary); border: none; border-radius: 8px; color: #000; font-size: 15px; font-weight: 700; cursor: pointer; transition: background 0.2s; }
        .btn-submit:hover { background-color: var(--primary-hover); }

        .msg { font-size: 13px; text-align: center; margin-top: 12px; padding: 8px; border-radius: 6px; display: none; }
        .msg.error { display: block; background: rgba(246, 70, 93, 0.15); color: var(--error); }
        .msg.success { display: block; background: rgba(14, 203, 129, 0.15); color: var(--success); }

        /* Dashboard View CSS */
        .dashboard-container { display: none; width: 100%; max-width: 800px; background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: 16px; padding: 25px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
        .dash-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 15px; margin-bottom: 20px; }
        .btn-logout { padding: 8px 16px; background-color: transparent; border: 1px solid var(--error); color: var(--error); border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.2s; }
        .btn-logout:hover { background-color: var(--error); color: #fff; }
        .balance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .balance-card { background: var(--bg-color); border: 1px solid var(--border-color); padding: 15px; border-radius: 10px; }
        .balance-card h3 { font-size: 13px; color: var(--text-muted); margin-bottom: 5px; }
        .balance-card p { font-size: 20px; font-weight: 700; color: var(--primary); }

        /* Responsive Mobile Code */
        @media (max-width: 480px) {
            body { padding: 10px; }
            .auth-container, .dashboard-container { padding: 15px; border-radius: 12px; }
            .logo-area h1 { font-size: 21px; }
            .input-group input { padding: 10px; font-size: 14px; }
            .btn-submit { padding: 12px; font-size: 14px; }
            .dash-header h2 { font-size: 18px; }
        }
    </style>
</head>
<body>

<div class="auth-container" id="authView">
    <div class="whitelist-warn">
        <span class="icon">⚠️</span>
        <div>Cài đặt địa chỉ IP WHITE LIST để sử dụng bot: 171.244.45.122</div>
    </div>

    <div class="logo-area">
        <h1>Luffy Cafe Crypto</h1>
        <p>Hệ thống tự động hóa giao dịch chuyên nghiệp</p>
    </div>

    <div class="tabs">
        <button class="tab-btn active" id="tab-login" onclick="switchTab('login')">Login</button>
        <button class="tab-btn" id="tab-register" onclick="switchTab('register')">Register</button>
    </div>

    <div id="login-panel" class="form-panel active">
        <form id="loginForm">
            <div class="input-group">
                <label>Username</label>
                <input type="text" id="login-user" required placeholder="Nhập tên tài khoản...">
            </div>
            <div class="input-group">
                <label>Password</label>
                <input type="password" id="login-pass" required placeholder="Nhập mật khẩu...">
            </div>
            <label class="remember-box">
                <input type="checkbox" id="rememberMe"> Remember Me
            </label>
            <button type="submit" class="btn-submit">Đăng Nhập</button>
            <div id="login-msg" class="msg"></div>
        </form>
    </div>

    <div id="register-panel" class="form-panel">
        <form id="registerForm">
            <div class="section-title">Thông tin tài khoản</div>
            <div class="input-group">
                <label>Username *</label>
                <input type="text" id="reg-user" required placeholder="Tên tài khoản viết liền...">
            </div>
            <div class="input-group">
                <label>Email *</label>
                <input type="email" id="reg-email" required placeholder="crypto@luffycafe.com">
            </div>
            <div class="input-group">
                <label>Password *</label>
                <input type="password" id="reg-pass" required placeholder="Mật khẩu tối thiểu 6 kí tự...">
            </div>
            <div class="input-group">
                <label>Repeat Password *</label>
                <input type="password" id="reg-repass" required placeholder="Xác nhận lại mật khẩu...">
            </div>

            <div class="section-title">Cấu hình API Binance (Tùy chọn)</div>
            <div class="input-group">
                <label>Binance API Key</label>
                <input type="text" id="reg-binance-key" placeholder="Nhập Binance API Key...">
            </div>
            <div class="input-group">
                <label>Binance Secret Key</label>
                <input type="text" id="reg-binance-secret" placeholder="Nhập Binance Secret Key...">
            </div>

            <div class="section-title">Cấu hình API Kucoin (Tùy chọn)</div>
            <div class="input-group">
                <label>Kucoin API Key</label>
                <input type="text" id="reg-kucoin-key" placeholder="Nhập Kucoin API Key...">
            </div>
            <div class="input-group">
                <label>Kucoin Secret Key</label>
                <input type="text" id="reg-kucoin-secret" placeholder="Nhập Kucoin Secret Key...">
            </div>
            <div class="input-group">
                <label>Kucoin Passphrase</label>
                <input type="password" id="reg-kucoin-passphrase" placeholder="Nhập Kucoin Passphrase...">
            </div>

            <button type="submit" class="btn-submit" style="margin-top: 15px;">Đăng Ký</button>
            <div id="reg-msg" class="msg"></div>
        </form>
    </div>
</div>

<div class="dashboard-container" id="dashboardView">
    <div class="dash-header">
        <div>
            <h2>Xin chào, <span id="dash-username" style="color: var(--primary);">User</span>!</h2>
            <p style="color: var(--text-muted); font-size: 13px;" id="dash-email"></p>
        </div>
        <button class="btn-logout" onclick="logout()">Đăng xuất</button>
    </div>

    <div class="section-title" style="font-size: 16px;">Số dư tài khoản thực tế (Mock API)</div>
    <div class="balance-grid">
        <div class="balance-card">
            <h3>Tổng số dư ví (USDT)</h3>
            <p id="bal-total">0.00</p>
        </div>
        <div class="balance-card">
            <h3>Ví Binance Futures</h3>
            <p id="bal-binance">0.00</p>
        </div>
        <div class="balance-card">
            <h3>Ví Kucoin Futures</h3>
            <p id="bal-kucoin">0.00</p>
        </div>
    </div>

    <div class="section-title" style="font-size: 16px;">Trạng thái Bot</div>
    <div class="balance-card" style="margin-bottom: 15px;">
        <h3>Trạng thái vận hành</h3>
        <p id="bot-status" style="color: var(--error); font-size: 18px;">Stopped</p>
    </div>
    <div class="balance-card">
        <h3>Nhật ký hệ thống (Logs)</h3>
        <div id="bot-logs" style="font-family: monospace; color: #fff; font-size: 13px; max-height: 150px; overflow-y: auto; margin-top: 8px; line-height: 1.5;"></div>
    </div>
</div>

<script>
    const API_URL = '/api';
    let currentUser = null;

    // Tự động kiểm tra phiên đăng nhập cũ khi tải trang
    window.onload = function() {
        const savedUser = localStorage.getItem('crypto_user') || sessionStorage.getItem('crypto_user');
        if (savedUser) {
            loadDashboard(savedUser);
        }
    };

    // Chuyển tab Đăng nhập / Đăng ký
    function switchTab(type) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.form-panel').forEach(p => p.classList.remove('active'));
        
        if(type === 'login') {
            document.getElementById('tab-login').classList.add('active');
            document.getElementById('login-panel').classList.add('active');
        } else {
            document.getElementById('tab-register').classList.add('active');
            document.getElementById('register-panel').classList.add('active');
        }
    }

    // Xử lý Sự kiện Đăng ký
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msgDiv = document.getElementById('reg-msg');
        msgDiv.className = 'msg';
        
        const username = document.getElementById('reg-user').value.trim();
        const email = document.getElementById('reg-email').value.trim();
        const password = document.getElementById('reg-pass').value;
        const repass = document.getElementById('reg-repass').value;

        if (password !== repass) {
            msgDiv.classList.add('error');
            msgDiv.innerText = 'Mật khẩu nhập lại không khớp!';
            return;
        }

        const payload = {
            username,
            email,
            password,
            binanceApiKey: document.getElementById('reg-binance-key').value.trim(),
            binanceSecret: document.getElementById('reg-binance-secret').value.trim(),
            kucoinApiKey: document.getElementById('reg-kucoin-key').value.trim(),
            kucoinSecret: document.getElementById('reg-kucoin-secret').value.trim(),
            kucoinPassphrase: document.getElementById('reg-kucoin-passphrase').value.trim()
        };

        try {
            const res = await fetch(\`\${API_URL}/register\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.success) {
                msgDiv.classList.add('success');
                msgDiv.innerText = data.message;
                
                setTimeout(() => {
                    switchTab('login');
                    document.getElementById('login-user').value = username;
                    document.getElementById('login-pass').value = '';
                    msgDiv.style.display = 'none';
                    document.getElementById('registerForm').reset();
                }, 1500);
            } else {
                msgDiv.classList.add('error');
                msgDiv.innerText = data.message;
            }
        } catch (err) {
            msgDiv.classList.add('error');
            msgDiv.innerText = 'Không kết nối được đến máy chủ!';
        }
    });

    // Xử lý Sự kiện Đăng nhập
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msgDiv = document.getElementById('login-msg');
        msgDiv.className = 'msg';

        const username = document.getElementById('login-user').value.trim();
        const password = document.getElementById('login-pass').value;
        const rememberMe = document.getElementById('rememberMe').checked;

        try {
            const res = await fetch(\`\${API_URL}/login\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (data.success) {
                msgDiv.classList.add('success');
                msgDiv.innerText = data.message;

                if (rememberMe) {
                    localStorage.setItem('crypto_user', username);
                } else {
                    sessionStorage.setItem('crypto_user', username);
                }

                setTimeout(() => {
                    loadDashboard(username);
                }, 1000);
            } else {
                msgDiv.classList.add('error');
                msgDiv.innerText = data.message;
            }
        } catch (err) {
            msgDiv.classList.add('error');
            msgDiv.innerText = 'Không kết nối được đến máy chủ!';
        }
    });

    // Hàm tải dữ liệu và hiển thị giao diện Dashboard
    async function loadDashboard(username) {
        currentUser = username;
        document.getElementById('authView').style.display = 'none';
        document.getElementById('dashboardView').style.display = 'block';
        document.getElementById('dash-username').innerText = username;

        try {
            // 1. Lấy thông tin email từ cấu hình hệ thống công khai công khai
            const configRes = await fetch(\`\${API_URL}/user-config?username=\${username}\`);
            const configData = await configRes.json();
            if(configData.success) {
                document.getElementById('dash-email').innerText = configData.data.email || '';
            }

            // 2. Lấy số dư ví từ API
            const balRes = await fetch(\`\${API_URL}/wallet-balance?username=\${username}\`);
            const balData = await balRes.json();
            if(balData.hasAPI) {
                document.getElementById('bal-total').innerText = balData.totalBalance + " USDT";
                document.getElementById('bal-binance').innerText = balData.binanceBalance + " USDT";
                document.getElementById('bal-kucoin').innerText = balData.kucoinBalance + " USDT";
            } else {
                document.getElementById('bal-total').innerText = "Chưa thiết lập API";
            }

            // 3. Lấy trạng thái bot
            const statusRes = await fetch(\`\${API_URL}/status\`);
            const statusData = await statusRes.json();
            document.getElementById('bot-status').innerText = statusData.status;
            document.getElementById('bot-logs').innerHTML = statusData.logs.map(log => \`<div>> \${log}</div>\`).join('');

        } catch (e) {
            console.error("Lỗi khi tải dữ liệu giao diện quản trị", e);
        }
    }

    // Đăng xuất xóa phiên
    function logout() {
        localStorage.removeItem('crypto_user');
        sessionStorage.removeItem('crypto_user');
        currentUser = null;
        document.getElementById('dashboardView').style.display = 'none';
        document.getElementById('authView').style.display = 'block';
        document.getElementById('loginForm').reset();
        document.getElementById('login-msg').style.display = 'none';
    }
</script>
</body>
</html>
    `);
});

// Khởi chạy máy chủ
app.listen(PORT, () => {
    console.log(`=== LUFFY CAFE CRYPTO SERVER RUNNING AT http://localhost:${PORT} ===`);
});
