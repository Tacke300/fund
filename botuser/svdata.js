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

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

app.get('/admin/setvip', (req, res) => {
    const { secret, username, level, days } = req.query;

    if (secret !== ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: 'Forbidden. Invalid secret key.' });
    }

    if (!username || !level || !days) {
        return res.status(400).json({ error: 'Missing parameters. Required: username, level, days.' });
    }

    const expiry = Date.now() + (parseInt(days) * 86400000);
    const vipLevel = parseInt(level);
    const sql = `UPDATE users SET is_vip = 1, vip_level = ?, vip_expiry_timestamp = ? WHERE username = ?`;

    db.run(sql, [vipLevel, expiry, username], function(err) {
        if (err) {
            return res.status(500).json({ success: false, message: 'Database error.', error: err.message });
        }
        if (this.changes === 0) {
             return res.status(404).json({ success: false, message: `User '${username}' not found.` });
        }
        res.status(200).json({ success: true, message: `Successfully set user '${username}' to VIP level ${level} for ${days} days.` });
    });
});


app.get('/admin', (req, res) => {
    const secret = req.query.secret;
    if (secret !== ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
    db.all('SELECT * FROM users', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
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
});

app.listen(port, () => {
    safeLog('info', `Unified server running at http://localhost:${port}`);
});
