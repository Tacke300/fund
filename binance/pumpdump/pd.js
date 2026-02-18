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

// Cấu hình bot
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

// --- HÀM CORE: XỬ LÝ API BINANCE CHUẨN ---
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
                } catch (e) { reject({ msg: "JSON Parse Error", raw: data }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// Lấy thông tin bước giá (Vô cùng quan trọng để không bị lỗi sàn)
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
    } catch (e) { console.error("Lỗi lấy ExchangeInfo:", e); }
}

// --- LOGIC CHIẾN LƯỢC PUMPDUMP ---
async function mainLoop() {
    if (!botSettings.isRunning) return;

    try {
        // 1. Cập nhật số dư & Kiểm tra SL Tổng
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        if (status.initialBalance === 0) {
            status.initialBalance = status.currentBalance;
            status.highestBalance = status.currentBalance;
        }

        if (botSettings.isProtectProfit && status.currentBalance > status.highestBalance) {
            status.highestBalance = status.currentBalance;
        }

        let stopThreshold = botSettings.accountSLType === 'fixed' 
            ? status.highestBalance - botSettings.accountSLValue 
            : status.highestBalance * (1 - botSettings.accountSLValue / 100);

        if (status.currentBalance <= stopThreshold) {
            return await panicStop("Chạm ngưỡng sụt giảm tài khoản (Account SL)!");
        }

        // 2. Kiểm tra số lượng vị thế & Giãn cách
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        if (activePos.length >= botSettings.maxPositions) return;
        if (Date.now() - status.lastOpenTimestamp < botSettings.openInterval) return;

        // 3. Quét VPS1 tìm coin biến động nhất
        http.get('http://34.142.248.96:9000/', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', async () => {
                const vps = JSON.parse(data);
                if (vps.status !== "running_data_available") return;

                const candidates = vps.data
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .filter(c => !activePos.some(p => p.symbol === c.symbol))
                    .filter(c => !status.blacklist.has(c.symbol))
                    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

                if (candidates.length > 0) await openPumpDumpOrder(candidates[0]);
            });
        });

    } catch (e) { console.error("Lỗi vòng lặp chính:", e.msg || e); }
}

async function openPumpDumpOrder(coin) {
    try {
        const symbol = coin.symbol;
        const info = status.exchangeInfo[symbol];
        if (!info) return;

        // Xác định hướng: Biến động âm -> Short, Dương -> Long
        const side = coin.changePercent > 0 ? 'BUY' : 'SELL';
        const posSide = coin.changePercent > 0 ? 'LONG' : 'SHORT';

        // Lấy giá hiện tại
        const ticker = await new Promise(res => {
            https.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
            });
        });
        const price = parseFloat(ticker.price);

        // Tính toán đòn bẩy và TP/SL theo yêu cầu của bạn
        let leverage = 20; 
        if (coin.changePercent > 10) leverage = 50; // Ví dụ tăng đòn bẩy nếu pump mạnh
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });

        // Tính khối lượng (Quantity)
        let investUSD = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
        let qty = (investUSD * leverage) / price;
        qty = Math.floor(qty / info.stepSize) * info.stepSize;
        const finalQty = qty.toFixed(info.quantityPrecision);

        // ĐẶT LỆNH MARKET
        const order = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty
        });

        // TÍNH TP/SL THEO ĐÒN BẨY (Target Profit Margin %)
        let marginGain = 1.0; // Mặc định 100%
        if (leverage >= 75) marginGain = 5.0; 
        else if (leverage >= 50) marginGain = 3.5;
        else if (leverage >= 26) marginGain = 2.0;

        const priceMove = (price * marginGain) / leverage;
        const tpPrice = (posSide === 'LONG' ? price + priceMove : price - priceMove);
        const slPrice = (posSide === 'LONG' ? price - (priceMove/2) : price + (priceMove/2));

        const tpPriceFinal = (Math.round(tpPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
        const slPriceFinal = (Math.round(slPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);

        // ĐẶT TP/SL BẰNG BATCH ORDERS
        const batch = [
            { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPriceFinal, closePosition: 'true' },
            { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: slPriceFinal, closePosition: 'true' }
        ];
        await callSignedAPI('/fapi/v1/batchOrders', 'POST', { batchOrders: JSON.stringify(batch) });

        status.lastOpenTimestamp = Date.now();
        saveLog(symbol, posSide, investUSD, tpPriceFinal, slPriceFinal);

    } catch (e) {
        console.error(`Lỗi vào lệnh ${coin.symbol}:`, e.msg || e);
        status.blacklist.add(coin.symbol);
    }
}

async function panicStop(reason) {
    botSettings.isRunning = false;
    // Gửi lệnh đóng toàn bộ vị thế Market ở đây...
    console.error("PANIC STOP KÍCH HOẠT:", reason);
}

function saveLog(symbol, side, capital, tp, sl) {
    const log = { symbol, side, capital, tp, sl, time: new Date().toLocaleString() };
    let logs = [];
    if (fs.existsSync(HISTORY_FILE)) logs = JSON.parse(fs.readFileSync(HISTORY_FILE));
    logs.push(log);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(logs, null, 2));
}

// Khởi động bot
refreshExchangeInfo();
setInterval(mainLoop, 5000);

// API cho giao diện HTML
const APP = express();
APP.use(express.json());
APP.post('/api/settings', (req, res) => { botSettings = {...botSettings, ...req.body}; res.sendStatus(200); });
APP.get('/api/status', async (req, res) => {
    res.json({ botSettings, status, history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)).slice(-10) : [] });
});
APP.listen(9001);
