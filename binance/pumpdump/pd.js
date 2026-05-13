import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, 
    options: { defaultType: 'future', dualSidePosition: true } 
});

// Khởi tạo đúng cấu trúc mà HTML chờ đợi
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: 4 };
let status = { 
    botLogs: [], 
    candidatesList: [], // Danh sách kèo tiềm năng
    blackList: {}, 
    botClosedCount: 0, 
    botPnLClosed: 0,
    exchangeInfo: null,
    isReady: false
};

let botActivePositions = new Map();
let isProcessingDCA = new Set();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 20) status.botLogs.pop();
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const res = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return res.data;
}

// Logic chính: Đưa data về đúng định dạng HTML cần
const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        
        // Fix lỗi Blacklist: HTML cần giây (number), không phải timestamp
        const blFormatted = {};
        const now = Date.now();
        Object.keys(status.blackList).forEach(s => {
            const diff = Math.floor((status.blackList[s] - now) / 1000);
            if (diff > 0) blFormatted[s] = diff;
            else delete status.blackList[s];
        });

        // Map lại danh sách vị thế để khớp với p.priceDev, p.pnl trong HTML
        const positions = Array.from(botActivePositions.values()).map(p => ({
            ...p,
            priceDev: parseFloat(p.priceDev || 0),
            pnl: parseFloat(p.pnl || 0),
            leverage: p.leverage || 20
        }));

        res.json({
            botSettings,
            activePositions: positions,
            status: { 
                ...status, 
                blackList: blFormatted,
                // Đảm bảo candidatesList luôn là mảng để không lỗi .slice()
                candidatesList: Array.isArray(status.candidatesList) ? status.candidatesList : []
            },
            wallet: {
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
            }
        });
    } catch (e) {
        console.error("Status Error:", e.message);
        res.status(500).json({ error: "API Error" });
    }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ success: true });
});

// Cập nhật kèo tiềm năng từ port 9000 (Giữ nguyên cấu trúc c.c1, c.c5...)
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { 
            try { 
                const raw = JSON.parse(d);
                status.candidatesList = raw.live || []; 
            } catch (e) { status.candidatesList = []; }
        });
    }).on('error', () => { status.candidatesList = []; });
}, 1500);

// --- CÁC HÀM KHỞI TẠO VÀ MONITOR (GIỮ NGUYÊN LOGIC CỦA ÔNG) ---
async function init() {
    try {
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const temp = {};
        info.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize),
                maxLeverage: 20 
            };
        });
        status.exchangeInfo = temp;
        status.isReady = true;
        addBotLog("Bot Ready!", "success");
    } catch (e) { setTimeout(init, 5000); }
}

init();
APP.listen(9001, () => console.log("Server chạy tại port 9001"));
