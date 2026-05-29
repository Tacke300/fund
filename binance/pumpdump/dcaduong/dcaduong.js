import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

let botSettings = { capital: "100", volVolatility: 6.5, maxPos: 3, dcaInterval: 2, tp: 1.2, sl: 10.0 };
if (fs.existsSync(CONFIG_FILE)) botSettings = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

let status = { botLogs: [{time: new Date().toLocaleTimeString(), msg: "Hệ thống sẵn sàng..."}], botClosedCount: 0, totalClosedPnL: 0 };

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now();
    const queryStr = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryStr).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${queryStr}&signature=${signature}`;
    return (await axios({ method, url, headers: { 'X-MBX-APIKEY': API_KEY } })).data;
}

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        res.json({
            wallet: { totalWalletBalance: acc.totalWalletBalance, availableBalance: acc.availableBalance, totalUnrealizedProfit: acc.totalUnrealizedProfit },
            activePositions: posRisk.filter(p => parseFloat(p.positionAmt) !== 0),
            status: { ...status, candidatesList: [] }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = req.body;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2));
    status.botLogs.unshift({time: new Date().toLocaleTimeString(), msg: "Đã lưu cấu hình mới"});
    res.json({ success: true });
});

APP.listen(1114, () => console.log('Bot chạy tại http://localhost:1114'));
