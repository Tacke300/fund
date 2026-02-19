import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { API_KEY, SECRET_KEY } from './config.js';

const HISTORY_FILE = path.join(__dirname, 'trade_history.json');
const LOG_LIMIT = 50; // Giới hạn số lượng log lưu trữ

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = {
    isRunning: false,
    maxPositions: 10,
    invValue: 1.5,
    invType: 'fixed', // 'fixed' là $, 'percent' là %
    minVol: 5.0,
    accountSLValue: 30,
    isProtectProfit: true,
};

let status = {
    currentBalance: 0,
    exchangeInfo: null,
    botLogs: [] // Lưu trữ các hành động của bot
};

// Hàm thêm log tại server
function addBotLog(msg, type = 'info') {
    const logEntry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(logEntry);
    if (status.botLogs.length > LOG_LIMIT) status.botLogs.pop();
    console.log(`[${logEntry.time}] ${msg}`);
}

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

// Tự động chỉnh Leverage lên MAX cho Symbol
async function setMaxLeverage(symbol) {
    try {
        const brackets = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol });
        const maxLev = brackets[0].brackets[0].initialLeverage;
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage: maxLev });
        return maxLev;
    } catch (e) { return 20; } // Mặc định 20 nếu lỗi
}

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
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                stepSize: parseFloat(lotFilter.stepSize),
                quantityPrecision: s.quantityPrecision
            };
        });
        addBotLog("Đã cập nhật thông tin sàn (Exchange Info)", "success");
    } catch (e) { addBotLog("Lỗi cập nhật Exchange Info", "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    
    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        // Kiểm tra SL tài khoản
        // (Logic SL tài khoản có thể thêm ở đây)

        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        if (activePos.length >= botSettings.maxPositions) return;

        // Lấy tín hiệu từ SVPD (Cổng 9000)
        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', async () => {
                try {
                    const candidates = JSON.parse(data).filter(c => Math.abs(c.changePercent) >= botSettings.minVol);
                    
                    for (const cand of candidates) {
                        if (activePos.find(p => p.symbol === cand.symbol)) continue;
                        if (activePos.length >= botSettings.maxPositions) break;

                        // Tính toán số tiền vào lệnh (Margin)
                        let marginPerOrder = botSettings.invValue;
                        if (botSettings.invType === 'percent') {
                            marginPerOrder = (status.currentBalance * botSettings.invValue) / 100;
                        }

                        addBotLog(`Đang thử mở lệnh ${cand.symbol}...`, "info");
                        const lev = await setMaxLeverage(cand.symbol);
                        
                        // Tính Quantity dựa trên Margin và Leverage
                        const priceRes = await callSignedAPI('/fapi/v1/ticker/price', 'GET', { symbol: cand.symbol });
                        const price = parseFloat(priceRes.price);
                        let qty = (marginPerOrder * lev) / price;
                        
                        // Làm tròn qty theo stepSize
                        const info = status.exchangeInfo[cand.symbol];
                        qty = Math.floor(qty / info.stepSize) * info.stepSize;

                        const side = cand.changePercent > 0 ? 'BUY' : 'SELL';
                        
                        await callSignedAPI('/fapi/v1/order', 'POST', {
                            symbol: cand.symbol,
                            side: side,
                            type: 'MARKET',
                            quantity: qty.toFixed(info.quantityPrecision)
                        });

                        addBotLog(`Thành công: Mở ${side} ${cand.symbol} | Lev: ${lev}x | Vốn: $${marginPerOrder.toFixed(2)}`, "success");
                    }
                } catch (e) { }
            });
        }).on('error', () => {
            if (botSettings.isRunning) addBotLog("Không thể kết nối SVPD (Cổng 9000)", "error");
        });
    } catch (e) {
        addBotLog("Lỗi kết nối Binance API", "error");
    }
}

// --- WEB SERVER ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const mark = parseFloat(p.markPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = parseFloat(p.unrealizedProfit);
            const lev = parseFloat(p.leverage);
            const margin = (entry * amt) / lev;
            return {
                symbol: p.symbol,
                side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                leverage: lev,
                entryPrice: entry.toFixed(5),
                markPrice: mark.toFixed(5),
                margin: margin.toFixed(2),
                pnl: pnl.toFixed(2),
                pnlPercent: ((pnl / margin) * 100).toFixed(2),
                tp: p.takeProfitPrice || '--', // Có thể thêm logic lấy TP/SL thật từ open orders
                sl: p.stopLossPrice || '--'
            };
        });

        res.json({ 
            botSettings, 
            status: { ...status, botLogs: status.botLogs }, // Trả về cả danh sách log
            activePositions, 
            history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [] 
        });
    } catch (e) { res.status(500).json({ error: "API Error" }); }
});

APP.post('/api/settings', (req, res) => {
    const oldRunning = botSettings.isRunning;
    botSettings = { ...botSettings, ...req.body };
    
    if (oldRunning !== botSettings.isRunning) {
        addBotLog(botSettings.isRunning ? "Lệnh từ Thuyền trưởng: GIƯƠNG BUỒM!" : "Lệnh từ Thuyền trưởng: HẠ BUỒM!", "warn");
    } else {
        addBotLog("Đã cập nhật cấu hình hạm đội mới", "info");
    }
    res.sendStatus(200);
});

// KHỞI CHẠY
refreshExchangeInfo();
setInterval(mainLoop, 10000); // Check tín hiệu mỗi 10 giây
APP.listen(9001, '0.0.0.0', () => {
    console.log("⚓ Pirate King Bot Server v3.5 đã sẵn sàng tại cổng 9001");
});
