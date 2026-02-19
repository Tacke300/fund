import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let botSettings = { 
    isRunning: false, maxPositions: 10, invValue: 1.5, minVol: 5.0, 
    accountSL: 30, slUnit: 'percent', useTrailingSL: false 
};

let status = { 
    currentBalance: 0, startBalance: 0, highestBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [],
    isProcessing: false // BIẾN KHÓA: Đợi ghim xong TP/SL mới mở lệnh tiếp
};

let history = []; 
let isInitializing = true;

// --- BINANCE API CORE ---
async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 5000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(d)); } catch (e) { reject({ msg: "JSON_ERROR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- LOGIC GHIM TP/SL VÀ MỞ KHÓA ---
async function fastEnforce(symbol) {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
        const p = pos.find(x => parseFloat(x.positionAmt) !== 0);
        if (!p) { status.isProcessing = false; return; }

        const info = status.exchangeInfo[symbol];
        const entry = parseFloat(p.entryPrice);
        const lev = parseFloat(p.leverage);
        const side = p.positionSide;
        
        // Tính TP/SL 1:1
        let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : 3.33);
        const rate = m / lev;
        const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
        const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        await Promise.all([
            callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' }),
            callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' })
        ]);
        
        addBotLog(`🛡️ ${symbol} đã ghim TP/SL. Sẵn sàng lệnh tiếp theo.`, "success");
    } catch (e) { addBotLog(`Lỗi ghim ${symbol}: ${JSON.stringify(e)}`, "error"); }
    finally {
        status.isProcessing = false; // MỞ KHÓA SAU KHI XỬ LÝ XONG
    }
}

// --- STOP ALL (NÚT STOP KHẨN CẤP) ---
async function emergencyStop() {
    botSettings.isRunning = false;
    addBotLog("🛑 DỪNG KHẨN CẤP! Đang đóng toàn bộ vị thế...", "error");
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        for (const p of active) {
            const side = parseFloat(p.positionAmt) > 0 ? 'SELL' : 'BUY';
            await callBinance('/fapi/v1/order', 'POST', { 
                symbol: p.symbol, side, positionSide: p.positionSide, 
                type: 'MARKET', quantity: Math.abs(parseFloat(p.positionAmt)) 
            });
        }
        addBotLog("✅ Đã dọn dẹp sạch chiến trường.", "success");
    } catch (e) { addBotLog("Lỗi khi dừng khẩn cấp.", "error"); }
}

// --- LUỒNG TRUY QUÉT ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || status.isProcessing) return;

    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        // Check SL Tài khoản
        if (status.startBalance === 0) { status.startBalance = status.currentBalance; status.highestBalance = status.currentBalance; }
        if (botSettings.useTrailingSL && status.currentBalance > status.highestBalance) status.highestBalance = status.currentBalance;
        
        let threshold = botSettings.slUnit === 'percent' ? status.highestBalance * (1 - botSettings.accountSL / 100) : status.highestBalance - botSettings.accountSL;
        if (status.currentBalance <= threshold) return emergencyStop();

        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length >= botSettings.maxPositions) return;

        // Tìm kèo
        for (const c of status.candidatesList) {
            if (active.some(p => p.symbol === c.symbol)) continue;

            status.isProcessing = true; // KHÓA LẠI NGAY KHI TÌM ĐƯỢC KÈO
            addBotLog(`🎯 Phát hiện kèo ${c.symbol}, đang mở lệnh...`);
            
            const info = status.exchangeInfo[c.symbol];
            const side = c.changePercent > 0 ? 'LONG' : 'SHORT';
            const ticker = await callBinance('/fapi/v1/ticker/price', { symbol: c.symbol });
            const price = parseFloat(ticker.price);
            const lev = 20; // Có thể lấy động từ bracket nếu muốn
            
            let qty = (botSettings.invValue * lev / price);
            qty = Math.floor(qty / info.stepSize) * info.stepSize;

            await callBinance('/fapi/v1/order', 'POST', {
                symbol: c.symbol, side: (side === 'LONG' ? 'BUY' : 'SELL'),
                positionSide: side, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
            });

            setTimeout(() => fastEnforce(c.symbol), 3000); // 3s sau ghim TP/SL và mở khóa
            break; // Thoát vòng lặp để xử lý xong lệnh này đã
        }
    } catch (e) {}
}

// (Các phần API Express giữ nguyên nhưng thêm route cho Emergency Stop)
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({status:"ok"}); });
APP.post('/api/stop-all', async (req, res) => { await emergencyStop(); res.json({status:"ok"}); });
APP.get('/api/status', async (req, res) => { /* Code cũ */ res.json({botSettings, status, activePositions: [], history: []}); });

init(); // Nạp exchange info
setInterval(hunt, 4000);
APP.listen(9001);
