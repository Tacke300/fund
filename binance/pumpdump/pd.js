import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'trade_history.json');

// --- Cấu hình mặc định ---
const VPS1_DATA_URL = 'http://34.142.248.96:9000/';
const BASE_HOST = 'fapi.binance.com';
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

let botSettings = {
    isRunning: false,
    maxPositions: 5,
    investmentType: 'fixed', // 'fixed' ($) hoặc 'percent' (%)
    investmentValue: 1.5,
    minVolatility: 5.0,
    openInterval: 30000 // 30s
};

let activePositions = new Set();
let blacklist = new Set();
let totalNetPnl = 0;
let lastOpenTime = 0;
let serverTimeOffset = 0;

// --- Helper Functions ---
const addLog = (msg) => {
    const time = new Date().toLocaleString('vi-VN');
    console.log(`[${time}] ${msg}`);
};

const saveHistory = (data) => {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    }
    history.push(data);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
};

// --- Binance API Cơ bản ---
async function callApi(method, path, params = {}, signed = true) {
    const timestamp = Date.now() + serverTimeOffset;
    let queryString = Object.keys(params).map(k => `${k}=${params[k]}`).join('&');
    if (signed) {
        queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
        queryString += `&signature=${signature}`;
    }
    
    const url = `https://${BASE_HOST}${path}${queryString ? '?' + queryString : ''}`;
    return new Promise((resolve, reject) => {
        const options = { method, headers: { 'X-MBX-APIKEY': API_KEY } };
        const req = https.request(url, options, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                const resData = JSON.parse(data);
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(resData);
                else reject(resData);
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// --- Logic Chính ---
async function pumpDumpStrategy() {
    if (!botSettings.isRunning) return;

    // 1. Kiểm tra số lượng vị thế hiện tại
    try {
        const positions = await callApi('GET', '/fapi/v2/positionRisk');
        const currentActive = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        activePositions = new Set(currentActive.map(p => p.symbol));

        if (currentActive.length >= botSettings.maxPositions) return;

        // Giãn cách 30s
        if (Date.now() - lastOpenTime < botSettings.openInterval) return;

        // 2. Lấy dữ liệu VPS1
        const vpsRes = await new Promise(resolve => {
            http.get(VPS1_DATA_URL, res => {
                let d = ''; res.on('data', chunk => d += chunk);
                res.on('end', () => resolve(JSON.parse(d)));
            });
        });

        if (vpsRes.status !== "running_data_available") return;

        // 3. Lọc và ưu tiên coin % cao nhất
        const candidates = vpsRes.data
            .filter(c => Math.abs(c.changePercent) >= botSettings.minVolatility)
            .filter(c => !activePositions.has(c.symbol) && !blacklist.has(c.symbol))
            .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

        if (candidates.length > 0) {
            const target = candidates[0];
            await openPosition(target);
        }
    } catch (e) {
        addLog(`Lỗi chiến lược: ${e.message || JSON.stringify(e)}`);
    }
}

async function openPosition(coin) {
    try {
        addLog(`Đang mở lệnh cho ${coin.symbol} (${coin.changePercent}%)...`);
        
        // Cài đặt đòn bẩy (mặc định lấy theo bracket cao nhất có thể hoặc fix 20-50x)
        const leverage = 20; // Có thể lấy động từ leverageBracket
        await callApi('POST', '/fapi/v1/leverage', { symbol: coin.symbol, leverage });

        const side = coin.changePercent > 0 ? 'BUY' : 'SELL';
        const posSide = coin.changePercent > 0 ? 'LONG' : 'SHORT';
        
        // Tính toán khối lượng
        const price = await callApi('GET', '/fapi/v1/ticker/price', { symbol: coin.symbol }).then(r => parseFloat(r.price));
        let amount = botSettings.investmentValue;
        if (botSettings.investmentType === 'percent') {
            const acc = await callApi('GET', '/fapi/v2/account');
            amount = (parseFloat(acc.totalMarginBalance) * botSettings.investmentValue) / 100;
        }
        
        const qty = (amount * leverage) / price;
        // (Lưu ý: Cần thêm logic làm tròn theo stepSize của sàn ở đây để chạy thực tế)
        const finalQty = qty.toFixed(2); 

        // Đặt lệnh Market
        await callApi('POST', '/fapi/v1/order', {
            symbol: coin.symbol,
            side: side,
            positionSide: posSide,
            type: 'MARKET',
            quantity: finalQty
        });

        // Tính toán TP/SL theo đòn bẩy
        let pnlTarget = 1.0; // Mặc định 100%
        if (leverage >= 75) pnlTarget = 5.0;
        else if (leverage >= 50) pnlTarget = 3.5;
        else if (leverage >= 26) pnlTarget = 2.0;

        const priceChange = (price * pnlTarget) / leverage;
        const tpPrice = posSide === 'LONG' ? price + priceChange : price - priceChange;
        const slPrice = posSide === 'LONG' ? price - (priceChange / 2) : price + (priceChange / 2);

        // Đặt TP/SL (Batch)
        const batch = [
            { symbol: coin.symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice.toFixed(4), closePosition: 'true' },
            { symbol: coin.symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: slPrice.toFixed(4), closePosition: 'true' }
        ];

        await callApi('POST', '/fapi/v1/batchOrders', { batchOrders: JSON.stringify(batch) });
        
        lastOpenTime = Date.now();
        addLog(`Thành công: Mở ${posSide} ${coin.symbol}. TP: ${tpPrice.toFixed(4)}, SL: ${slPrice.toFixed(4)}`);

    } catch (e) {
        addLog(`Lỗi mở lệnh ${coin.symbol}: ${JSON.stringify(e)}`);
        blacklist.add(coin.symbol);
    }
}

// --- API cho Giao diện ---
APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addLog(`Cập nhật cài đặt: Bot ${botSettings.isRunning ? 'START' : 'STOP'}`);
    res.json({ status: 'ok' });
});

APP.get('/api/status', async (req, res) => {
    res.json({
        settings: botSettings,
        activePositions: Array.from(activePositions),
        totalNetPnl,
        history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : []
    });
});

// Khởi chạy
setInterval(pumpDumpStrategy, 5000);
APP.listen(9001, () => addLog('Web Server chạy tại port 9001'));
