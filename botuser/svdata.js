const express = require('express');
const path = require('path');
const cors = require('cors');
const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3000;
const DB_FILE = 'user.db';
const ADMIN_SECRET_KEY = 'huyen';

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        is_vip INTEGER DEFAULT 0, vip_level TEXT, vip_expiry_timestamp INTEGER,
        pnl REAL DEFAULT 0,
        binance_apikey TEXT, binance_secret TEXT,
        bitget_apikey TEXT, bitget_secret TEXT, bitget_password TEXT,
        okx_apikey TEXT, okx_secret TEXT, okx_password TEXT,
        kucoin_apikey TEXT, kucoin_secret TEXT, kucoin_password TEXT
    )`);
});

let activeBotInstance = {
    username: null, state: 'STOPPED', loopId: null, exchanges: {},
    tradeDetails: null, tradeHistory: [], balances: {}, pnl: 0
};

const safeLog = (type, ...args) => {
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
    console[type](`[${timestamp}]`, message);
};

// ... (Các hàm bot như initializeExchangesForUser, mainBotLoop, startBot, stopBot không thay đổi) ...
async function initializeExchangesForUser(userData) {
    const userExchanges = {};
    const exchangeConfigs = [
        { id: 'binanceusdm', apiKey: userData.binance_apikey, secret: userData.binance_secret, options: { 'defaultType': 'swap' } },
        { id: 'bitget', apiKey: userData.bitget_apikey, secret: userData.bitget_secret, password: userData.bitget_password, options: { 'defaultType': 'swap' } },
        { id: 'okx', apiKey: userData.okx_apikey, secret: userData.okx_secret, password: userData.okx_password, options: { 'defaultType': 'swap' } },
        { id: 'kucoinfutures', apiKey: userData.kucoin_apikey, secret: userData.kucoin_secret, password: userData.kucoin_password },
    ];
    for (const config of exchangeConfigs) {
        if (config.apiKey && config.secret) {
            try {
                const exchangeClass = ccxt[config.id];
                userExchanges[config.id] = new exchangeClass({
                    apiKey: config.apiKey, secret: config.secret, password: config.password, enableRateLimit: true, ...config.options
                });
            } catch (e) {
                safeLog('error', `Failed to init ${config.id} for ${userData.username}:`, e.message);
            }
        }
    }
    return userExchanges;
}

async function mainBotLoop() {
    if (activeBotInstance.state !== 'RUNNING') {
        clearTimeout(activeBotInstance.loopId);
        return;
    }
    try {
        safeLog('log', `Bot loop running for ${activeBotInstance.username}...`);
    } catch (e) {
        safeLog('error', 'Critical error in main loop:', e);
        await stopBot();
    }
    activeBotInstance.loopId = setTimeout(mainBotLoop, 5000);
}

async function startBot(username, marginOptions) {
    if (activeBotInstance.state === 'RUNNING') return false;
    const user = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
    if (!user) return false;
    const userExchanges = await initializeExchangesForUser(user);
    if (Object.keys(userExchanges).length === 0) return false;

    activeBotInstance = {
        username: username, state: 'RUNNING', loopId: null, exchanges: userExchanges,
        tradeDetails: null, tradeHistory: [], balances: {}, pnl: user.pnl, marginOptions: marginOptions
    };
    safeLog('info', `Bot started for user: ${username} with options`, marginOptions);
    mainBotLoop();
    return true;
}

async function stopBot() {
    if (activeBotInstance.state !== 'RUNNING') return false;
    clearTimeout(activeBotInstance.loopId);
    const { pnl: finalPnl, username } = activeBotInstance;
    activeBotInstance = { username: null, state: 'STOPPED', loopId: null, exchanges: {}, tradeDetails: null, tradeHistory: [], balances: {}, pnl: 0 };
    db.run('UPDATE users SET pnl = ? WHERE username = ?', [finalPnl, username], (err) => {
        if (err) safeLog('error', 'Failed to save final PNL to DB:', err.message);
    });
    safeLog('info', `Bot stopped for user: ${username}. Final PNL ${finalPnl} saved.`);
    return true;
}


app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ... (Các API cho người dùng cuối không thay đổi) ...
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], function(err) {
        if (err) return res.status(400).json({ success: false, message: 'Username already exists.' });
        res.status(201).json({ success: true, message: 'User registered successfully.' });
    });
});
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
        if (err || !row) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        res.status(200).json({ success: true, username: row.username });
    });
});
app.post('/api/status', (req, res) => {
    const { username } = req.body;
    db.get('SELECT id, username, is_vip, vip_level, vip_expiry_timestamp, pnl FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return res.status(404).json({ message: 'User not found.' });
        const isBotForThisUser = activeBotInstance.username === username;
        res.status(200).json({
            is_vip: user.is_vip, vip_level: user.vip_level, vip_expiry_timestamp: user.vip_expiry_timestamp,
            pnl: isBotForThisUser ? activeBotInstance.pnl : user.pnl,
            isBotRunning: isBotForThisUser && activeBotInstance.state === 'RUNNING',
            totalUsdt: isBotForThisUser ? Object.values(activeBotInstance.balances).reduce((s, b) => s + (b.total || 0), 0) : 0,
            tradeHistory: isBotForThisUser ? activeBotInstance.tradeHistory : []
        });
    });
});
app.post('/api/save-settings', (req, res) => {
    const { username, settings } = req.body;
    db.run(`UPDATE users SET binance_apikey = ?, binance_secret = ?, bitget_apikey = ?, bitget_secret = ?, bitget_password = ? WHERE username = ?`,
        [settings.binance_apikey, settings.binance_secret, settings.bitget_apikey, settings.bitget_secret, settings.bitget_password, username],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: 'Database error.' });
            res.status(200).json({ success: true, message: 'Settings saved successfully.' });
        });
});
app.post('/api/start', async (req, res) => {
    const { username, marginOptions } = req.body;
    const success = await startBot(username, marginOptions);
    res.status(200).json({ success });
});
app.post('/api/stop', async (req, res) => {
    const success = await stopBot();
    res.status(200).json({ success });
});


// --- PHẦN ADMIN NÂNG CẤP ---

app.post('/admin/update-user', (req, res) => {
    const { secret, username, level, days } = req.body;

    if (secret !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ success: false, message: 'Forbidden. Invalid secret key.' });
    }

    let sql, params;
    
    if (level === 'NONE') {
        sql = 'UPDATE users SET is_vip = 0, vip_level = NULL, vip_expiry_timestamp = NULL WHERE username = ?';
        params = [username];
    } else {
        const is_vip = 1;
        const vip_level = level; // '1', '2', '3', 'GOLD'
        // Dùng năm 9999 để biểu thị vĩnh viễn
        const expiry_timestamp = (level === 'GOLD') 
            ? new Date('9999-12-31T23:59:59Z').getTime()
            : Date.now() + (parseInt(days) * 86400000);

        sql = 'UPDATE users SET is_vip = ?, vip_level = ?, vip_expiry_timestamp = ? WHERE username = ?';
        params = [is_vip, vip_level, expiry_timestamp, username];
    }

    db.run(sql, params, function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: 'Database error.', error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: `User '${username}' not found.` });
        }
        res.status(200).json({ success: true, message: `User '${username}' updated successfully.` });
    });
});

app.get('/admin', (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET_KEY) return res.status(403).send('<h1>Forbidden</h1>');

    db.all('SELECT id, username, is_vip, vip_level, vip_expiry_timestamp FROM users ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).send(`<h1>Database Error: ${err.message}</h1>`);
        
        let userRowsHtml = rows.map(row => {
            const expiryDate = row.vip_expiry_timestamp ? new Date(row.vip_expiry_timestamp).toLocaleString('vi-VN') : 'N/A';
            const vipStatus = row.is_vip ? `${row.vip_level} (Hết hạn: ${row.vip_level === 'GOLD' ? 'Vĩnh viễn' : expiryDate})` : 'Không';
            return `
                <tr>
                    <td>${row.id}</td>
                    <td>${row.username}</td>
                    <td>${vipStatus}</td>
                    <td><button onclick="openVipModal('${row.username}', '${row.vip_level || ''}')">Set VIP</button></td>
                </tr>
            `;
        }).join('');

        res.send(`
            <!DOCTYPE html>
            <html lang="vi">
            <head>
                <meta charset="UTF-8">
                <title>Admin - Quản lý User</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2em; background-color: #f4f4f9; color: #333; }
                    table { border-collapse: collapse; width: 100%; box-shadow: 0 2px 3px rgba(0,0,0,0.1); }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
                    th { background-color: #007bff; color: white; }
                    tr:nth-child(even){ background-color: #f2f2f2; }
                    button { background-color: #007bff; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer; }
                    button:hover { background-color: #0056b3; }
                    .modal { position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.5); display: none; justify-content: center; align-items: center; }
                    .modal-content { background-color: #fefefe; padding: 20px; border: 1px solid #888; width: 80%; max-width: 400px; border-radius: 8px; }
                    .modal-header { padding-bottom: 10px; border-bottom: 1px solid #ccc; }
                    .close-btn { color: #aaa; float: right; font-size: 28px; font-weight: bold; cursor: pointer; }
                    .form-group { margin: 15px 0; }
                    label { display: block; margin-bottom: 5px; }
                    select, input { width: 100%; padding: 8px; box-sizing: border-box; }
                </style>
            </head>
            <body>
                <h1>Quản lý User</h1>
                <table>
                    <thead><tr><th>ID</th><th>Username</th><th>Trạng thái VIP</th><th>Hành động</th></tr></thead>
                    <tbody>${userRowsHtml}</tbody>
                </table>

                <div id="vip-modal" class="modal">
                    <div class="modal-content">
                        <div class="modal-header">
                            <span class="close-btn" onclick="closeVipModal()">&times;</span>
                            <h2 id="modal-title">Set VIP cho User</h2>
                        </div>
                        <div class="modal-body">
                            <input type="hidden" id="modal-username">
                            <div class="form-group">
                                <label for="vip-level">Cấp VIP</label>
                                <select id="vip-level" onchange="toggleDaysInput()">
                                    <option value="NONE">Không phải VIP</option>
                                    <option value="1">VIP 1</option>
                                    <option value="2">VIP 2</option>
                                    <option value="3">VIP 3</option>
                                    <option value="GOLD">VIP GOLD (Vĩnh viễn)</option>
                                </select>
                            </div>
                            <div class="form-group" id="days-group">
                                <label for="vip-days">Số ngày</label>
                                <input type="number" id="vip-days" value="30">
                            </div>
                            <button onclick="saveVipSettings()">Lưu thay đổi</button>
                        </div>
                    </div>
                </div>

                <script>
                    const modal = document.getElementById('vip-modal');
                    const usernameInput = document.getElementById('modal-username');
                    const levelSelect = document.getElementById('vip-level');
                    const daysInput = document.getElementById('vip-days');
                    const daysGroup = document.getElementById('days-group');
                    const modalTitle = document.getElementById('modal-title');

                    function openVipModal(username, currentLevel) {
                        modalTitle.innerText = 'Set VIP cho ' + username;
                        usernameInput.value = username;
                        levelSelect.value = currentLevel || 'NONE';
                        toggleDaysInput();
                        modal.style.display = 'flex';
                    }

                    function closeVipModal() {
                        modal.style.display = 'none';
                    }

                    function toggleDaysInput() {
                        const selectedLevel = levelSelect.value;
                        daysGroup.style.display = (selectedLevel === 'NONE' || selectedLevel === 'GOLD') ? 'none' : 'block';
                    }

                    async function saveVipSettings() {
                        const username = usernameInput.value;
                        const level = levelSelect.value;
                        const days = daysInput.value;

                        const response = await fetch('/admin/update-user', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                secret: '${ADMIN_SECRET_KEY}',
                                username: username,
                                level: level,
                                days: days
                            })
                        });

                        const result = await response.json();
                        if (result.success) {
                            alert('Cập nhật thành công!');
                            window.location.reload();
                        } else {
                            alert('Lỗi: ' + result.message);
                        }
                    }

                    window.onclick = function(event) {
                        if (event.target == modal) {
                            closeVipModal();
                        }
                    }
                </script>
            </body>
            </html>
        `);
    });
});

app.listen(port, () => {
    safeLog('info', `Unified server running at http://localhost:${port}`);
});
