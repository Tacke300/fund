const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const sqlite3 = require('sqlite3').verbose();

const BOT_PORT = 5006;
const DB_FILE = 'user.db'; // Đảm bảo tên file khớp với file database của bạn
const ADMIN_SECRET_KEY = 'huyen'; // <-- THAY MẬT KHẨU BÍ MẬT CỦA BẠN VÀO ĐÂY

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQLite database.');
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
        is_vip INTEGER DEFAULT 0, vip_level INTEGER, vip_expiry_timestamp INTEGER,
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

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    await new Promise(resolve => req.on('end', resolve));
    const sendJSON = (statusCode, data) => { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    try {
        if (url.pathname === '/') {
            fs.readFile(path.join(__dirname, 'index.html'), (err, content) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(content); });
        } else if (url.pathname === '/script.js') {
            fs.readFile(path.join(__dirname, 'script.js'), (err, content) => { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(content); });
        } else if (url.pathname.startsWith('/admin')) {
            const secret = url.searchParams.get('secret');
            if (secret !== ADMIN_SECRET_KEY) return sendJSON(403, { error: 'Forbidden' });
            db.all('SELECT * FROM users', [], (err, rows) => {
                if (err) return sendJSON(500, { error: err.message });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                let html = '<style>table{width:100%;border-collapse:collapse;}th,td{border:1px solid #ddd;padding:8px;text-align:left;}tr:nth-child(even){background-color:#f2f2f2;}</style><table><tr>';
                if(rows.length > 0){
                    Object.keys(rows[0]).forEach(key => html += `<th>${key}</th>`);
                    html += '</tr>';
                    rows.forEach(row => {
                        html += '<tr>';
                        Object.values(row).forEach(val => html += `<td>${val === null ? '' : val}</td>`);
                        html += '</tr>';
                    });
                }
                html += '</table>';
                res.end(html);
            });
        } else if (url.pathname === '/api/register' && req.method === 'POST') {
            const { username, password } = JSON.parse(body);
            db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, password], function(err) {
                if (err) return sendJSON(400, { success: false, message: 'Username already exists.' });
                sendJSON(201, { success: true, message: 'User registered successfully.' });
            });
        } else if (url.pathname === '/api/login' && req.method === 'POST') {
            const { username, password } = JSON.parse(body);
            db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, row) => {
                if (err || !row) return sendJSON(401, { success: false, message: 'Invalid credentials.' });
                sendJSON(200, { success: true, username: row.username });
            });
        } else if (url.pathname === '/api/status' && req.method === 'POST') {
            const { username } = JSON.parse(body);
            db.get('SELECT id, username, is_vip, vip_level, vip_expiry_timestamp, pnl FROM users WHERE username = ?', [username], (err, user) => {
                if (err || !user) return sendJSON(404, { message: 'User not found.' });
                const isBotForThisUser = activeBotInstance.username === username;
                sendJSON(200, {
                    is_vip: user.is_vip, vip_level: user.vip_level, vip_expiry_timestamp: user.vip_expiry_timestamp,
                    pnl: isBotForThisUser ? activeBotInstance.pnl : user.pnl,
                    isBotRunning: isBotForThisUser && activeBotInstance.state === 'RUNNING',
                    totalUsdt: isBotForThisUser ? Object.values(activeBotInstance.balances).reduce((s, b) => s + (b.total || 0), 0) : 0,
                    tradeHistory: isBotForThisUser ? activeBotInstance.tradeHistory : []
                });
            });
        } else if (url.pathname === '/api/save-settings' && req.method === 'POST') {
            const { username, settings } = JSON.parse(body);
            db.run(`UPDATE users SET binance_apikey = ?, binance_secret = ?, bitget_apikey = ?, bitget_secret = ?, bitget_password = ? WHERE username = ?`,
                [settings.binance_apikey, settings.binance_secret, settings.bitget_apikey, settings.bitget_secret, settings.bitget_password, username],
                function(err) {
                    if (err) return sendJSON(500, { success: false, message: 'Database error.' });
                    sendJSON(200, { success: true, message: 'Settings saved successfully.' });
                });
        } else if (url.pathname === '/api/start' && req.method === 'POST') {
            const { username, marginOptions } = JSON.parse(body);
            const success = await startBot(username, marginOptions);
            sendJSON(200, { success });
        } else if (url.pathname === '/api/stop' && req.method === 'POST') {
            const success = await stopBot();
            sendJSON(200, { success });
        } else if (url.pathname === '/api/set-vip' && req.method === 'POST') {
            const { username, level, days } = JSON.parse(body);
            const expiry = Date.now() + (days * 86400000);
            db.run('UPDATE users SET is_vip = 1, vip_level = ?, vip_expiry_timestamp = ? WHERE username = ?', [level, expiry, username], (err) => {
                if(err) return sendJSON(500, {success: false, message: err.message});
                sendJSON(200, {success: true, message: `${username} is now VIP level ${level} for ${days} days.`});
            });
        } else {
            sendJSON(404, { message: 'Not Found' });
        }
    } catch (error) {
        safeLog('error', `Server Error: ${error.message}`);
        if (!res.headersSent) sendJSON(500, { message: 'Internal Server Error' });
    }
});

server.listen(BOT_PORT, () => {
    safeLog('info', `Bot server running at http://localhost:${BOT_PORT}`);
});
