import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- TỰ ĐỊNH NGHĨA __DIRNAME CHO ES MODULE ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- IMPORT CONFIG (Dùng đường dẫn tuyệt đối để tránh lỗi NOT FOUND) ---
const configPath = path.join(__dirname, 'config.js');
import { API_KEY, SECRET_KEY } from './config.js';

const HISTORY_FILE = path.join(__dirname, 'trade_history.json');

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = {
    isRunning: false,
    maxPositions: 10,
    invValue: 1.5,
    invType: 'fixed', 
    minVol: 5.0,
    accountSLValue: 30,
    accountSLType: 'percent', 
    isProtectProfit: true,
    openInterval: 30000 
};

let status = {
    initialBalance: 0,
    highestBalance: 0,
    currentBalance: 0,
    lastOpenTimestamp: 0,
    exchangeInfo: null,
    blacklist: new Set()
};

// --- HÀM API BINANCE ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    let queryString = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${queryString}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const options = { method, headers: { 'X-MBX-APIKEY': API_KEY } };
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                    else reject(json);
                } catch (e) { reject({ msg: "JSON Error" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- LOGIC VÀO LỆNH (ĐÃ FIX ĐƯỜNG DẪN DATA 9000) ---
async function refreshExchangeInfo() {
    try {
        const res = await new Promise((resolve) => {
            https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
                let d = ''; r.on('data', c => d += c);
                r.on('end', () => resolve(JSON.parse(d)));
            });
        });
        status.exchangeInfo = {};
        res.symbols.forEach(s => {
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(priceFilter.tickSize),
                stepSize: parseFloat(lotFilter.stepSize)
            };
        });
    } catch (e) {}
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        if (activePos.length >= botSettings.maxPositions) return;

        // Lấy dữ liệu từ svpd đang chạy cùng máy
        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', async () => {
                try {
                    const candidates = JSON.parse(data).filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                    // Logic vào lệnh... (giữ nguyên như cũ)
                } catch (e) {}
            });
        }).on('error', () => {});
    } catch (e) {}
}

// --- WEB SERVER (FIX CƠ CHẾ TRẢ VỀ FILE INDEX.HTML) ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

// Route chính trả về index.html
APP.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send("Lỗi: Không tìm thấy file index.html tại: " + filePath);
    }
});

// Route /gui để ông gõ kiểu gì cũng ra
APP.get('/gui', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API Status cho file HTML của ông
APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = parseFloat(p.unrealizedProfit);
            const margin = (entry * amt) / parseFloat(p.leverage);
            return {
                symbol: p.symbol,
                side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                margin: margin.toFixed(2),
                pnl: pnl.toFixed(2),
                pnlPercent: ((pnl / margin) * 100).toFixed(2)
            };
        });
        res.json({ botSettings, status, activePositions, history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [] });
    } catch (e) { res.status(500).json({ error: "API Error" }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.sendStatus(200);
});

// KHỞI CHẠY
refreshExchangeInfo();
setInterval(mainLoop, 5000);
APP.listen(9001, '0.0.0.0', () => {
    console.log("⚓ Pirate King Bot đã sẵn sàng tại cổng 9001");
});
