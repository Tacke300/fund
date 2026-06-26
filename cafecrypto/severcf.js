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

let botRealPublicIp = '';

async function updateBotIp() {
    try {
        const res = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        if (res.data && res.data.ip) {
            botRealPublicIp = res.data.ip;
            console.log(`IPV4: ${botRealPublicIp}`);
        }
    } catch (e) {
        try {
            const backupRes = await axios.get('https://ipv4.icanhazip.com/', { timeout: 5000 });
            if (backupRes.data) {
                botRealPublicIp = backupRes.data.toString().trim();
                console.log(`IPV4: ${botRealPublicIp}`);
            }
        } catch (err) {
            botRealPublicIp = '127.0.0.1';
        }
    }
}
updateBotIp();
setInterval(updateBotIp, 3600000);

const getBotTargetUrl = (botId) => {
    if (botId === 1) return 'http://127.0.0.1:1840';
    if (botId === 2) return 'http://127.0.0.1:1841';
    return 'http://127.0.0.1:1842';
};

app.post('/api/register', (req, res) => {
    const { username, email, password, binanceApiKey, binanceSecret } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Invalid data' });
    const userPath = path.join(USER_DIR, username);
    if (fs.existsSync(userPath)) return res.status(400).json({ success: false, message: 'User exists' });
    fs.mkdirSync(userPath);
    const config = { username, email, password, binance: { apiKey: binanceApiKey || "", secret: binanceSecret || "" } };
    fs.writeFileSync(path.join(userPath, 'config.json'), JSON.stringify(config, null, 4), 'utf8');
    res.json({ success: true, message: 'Registered successfully' });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(400).json({ success: false, message: 'User not found' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.password !== password) return res.status(400).json({ success: false, message: 'Wrong password' });
    res.json({ success: true, message: 'Login successful' });
});

app.get('/api/bot-ip', (req, res) => {
    res.json({ ip: botRealPublicIp });
});

app.post('/api/save-api', (req, res) => {
    const { username, apiKey, secret } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false, message: 'User error' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.binance = { apiKey, secret };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    return res.json({ success: true, message: 'API Saved' });
});

app.post('/api/my-bot/toggle', async (req, res) => {
    const { username, isRunning, botId } = req.body;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.status(404).json({ success: false });
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const TARGET_URL = getBotTargetUrl(botId);
        const response = await axios.post(`${TARGET_URL}/api/user/toggle`, {
            username, apiKey: config.binance?.apiKey, secretKey: config.binance?.secret, isRunning
        }, { timeout: 5000 });
        return res.json(response.data);
    } catch (error) {
        console.log(error.message);
        return res.json({ success: false, msg: `Bot ${botId} offline` });
    }
});

app.get('/api/wallet-balance', async (req, res) => {
    const { username } = req.query;
    const configPath = getUserConfigPath(username);
    if (!fs.existsSync(configPath)) return res.json({ hasAPI: false });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.binance || !config.binance.apiKey) return res.json({ hasAPI: false });
    try {
        const response = await axios.post(`http://127.0.0.1:1842/api/user/status`, {
            username, apiKey: config.binance.apiKey, secretKey: config.binance.secret
        }, { timeout: 3000 });
        if (response.data && response.data.wallet) return res.json({ hasAPI: true, wallet: response.data.wallet });
    } catch (e) {
         try {
            const response2 = await axios.post(`http://127.0.0.1:1840/api/user/status`, {
                username, apiKey: config.binance.apiKey, secretKey: config.binance.secret
            }, { timeout: 3000 });
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
        }, { timeout: 3000 });
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

app.listen(PORT, () => console.log(`MASTER RUNNING PORT ${PORT}`));
