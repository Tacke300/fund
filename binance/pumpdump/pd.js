import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Đảm bảo config.js nằm cùng thư mục
import { API_KEY, SECRET_KEY } from './config.js';

const HISTORY_FILE = path.join(__dirname, 'trade_history.json');

// --- CẤU HÌNH HỆ THỐNG BẢN SỬA 01 ---
let botSettings = {
    isRunning: false,
    maxPositions: 10,
    invValue: 1.5,
    invType: 'fixed', // 'fixed' ($) hoặc 'percent' (%)
    minVol: 5.0,      // % biến động người dùng nhập từ Web
    accountSL: 30,
};

let status = {
    currentBalance: 0,
    botLogs: [],      // Danh sách log gửi về Web
    candidatesList: [], // Danh sách coin Radar
    exchangeInfo: null
};

// --- QUẢN LÝ LOG & CHẶN SPAM ---
let lastErrorMsg = "";
function addBotLog(msg, type = 'info') {
    // Nếu lỗi trùng với lỗi trước đó thì không đẩy vào mảng để tránh spam Web
    if (type === 'error' && msg === lastErrorMsg) return;
    if (type === 'error') lastErrorMsg = msg;
    else lastErrorMsg = "";

    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- BẮT LỖI CHI TIẾT TỪ BINANCE ---
function parseBinanceError(e) {
    if (e.code === -2015) return "Lỗi: API Key hoặc Secret sai rồi thuyền trưởng ơi!";
    if (e.code === -1021) return "Lỗi: Lệch thời gian hệ thống (Hãy đồng bộ lại Clock Windows)!";
    if (e.code === -2019) return "Lỗi: Ví Futures không đủ tiền đánh lệnh này!";
    if (e.code === -4003) return "Lỗi: Đòn bẩy (Leverage) quá cao, sàn không cho!";
    if (e.code === -1013) return "Lỗi: Số lượng (Qty) quá nhỏ, không bõ dính răng!";
    return `Lỗi từ sàn: ${e.msg || JSON.stringify(e)}`;
}

// --- HÀM API BINANCE (DÙNG HTTPS) ---
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
                } catch (err) { reject({ msg: "Lỗi định dạng JSON từ sàn" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- VÒNG LẶP CHÍNH (MAIN LOOP) ---
async function mainLoop() {
    if (!botSettings.isRunning) return;

    try {
        // 1. Cập nhật số dư
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        // 2. Lấy vị thế hiện tại
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        // 3. Lấy tín hiệu từ SVPD 9000
        http.get('http://127.0.0.1:9000/api/live', (res) => {
            let rawData = '';
            res.on('data', d => rawData += d);
            res.on('end', async () => {
                try {
                    const allData = JSON.parse(rawData);
                    // Lọc coin theo % biến động từ người dùng nhập
                    status.candidatesList = allData
                        .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                        .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                        .slice(0, 8); // Chỉ lấy 8 con mạnh nhất cho Radar

                    if (activePos.length >= botSettings.maxPositions) return;

                    for (const cand of status.candidatesList) {
                        if (activePos.find(p => p.symbol === cand.symbol)) continue;
                        if (activePos.length >= botSettings.maxPositions) break;

                        // TIẾN HÀNH MỞ LỆNH
                        addBotLog(`Đang thử săn con hàng ${cand.symbol}...`, "info");
                        // (Logic mở lệnh, tính Qty và Set Leverage ở đây như bản trước...)
                        // Ví dụ: addBotLog(`Mở lệnh ${cand.symbol} THÀNH CÔNG!`, "success");
                    }
                } catch (e) { }
            });
        }).on('error', () => {
            addBotLog("Lỗi: Không kết nối được app quét Coin (Cổng 9000)!", "error");
        });

    } catch (e) {
        addBotLog(parseBinanceError(e), "error");
    }
}

// --- WEB SERVER CỔNG 9001 ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

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
                leverage: p.leverage,
                entryPrice: entry.toFixed(5),
                markPrice: parseFloat(p.markPrice).toFixed(5),
                pnlPercent: ((pnl / margin) * 100).toFixed(2)
            };
        });

        res.json({ 
            botSettings, 
            status, 
            activePositions, 
            history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [] 
        });
    } catch (e) { res.status(500).json({ error: "Lỗi API" }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog("Đã cập nhật cấu hình hạm đội!", "success");
    res.sendStatus(200);
});

// Chạy khởi động
setInterval(mainLoop, 5000);
APP.listen(9001, '0.0.0.0', () => {
    console.log("⚓ Pirate King Bot Server [BẢN SỬA 01] đang chạy tại cổng 9001");
});
