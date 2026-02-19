import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = { 
    isRunning: false, maxPositions: 10, invValue: 1.5, minVol: 5.0, 
    accountSL: 30, slUnit: 'percent', useTrailingSL: false 
};

let status = { 
    currentBalance: 0, 
    startBalance: 0, 
    highestBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [],
    isProcessing: false // Khóa chống mở lệnh dồn dập
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
                try { 
                    const parsed = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
                    else reject(parsed);
                } catch (e) { reject({ msg: "JSON_ERROR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function addBotLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    status.botLogs.unshift(entry);
    if (status.botLogs.length > 30) status.botLogs.pop();
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

// --- LOGIC GHIM TP/SL (Cài xong mới mở khóa) ---
async function fastEnforce(symbol) {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
        const p = pos.find(x => parseFloat(x.positionAmt) !== 0);
        if (!p) { status.isProcessing = false; return; }

        const info = status.exchangeInfo[symbol];
        const entry = parseFloat(p.entryPrice);
        const lev = parseFloat(p.leverage);
        const side = p.positionSide;
        
        // Công thức TP/SL 1:1 dựa trên đòn bẩy
        let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : 3.33);
        const rate = m / lev;
        const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
        const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        await Promise.all([
            callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' }),
            callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' })
        ]);
        
        addBotLog(`🛡️ ${symbol} cài TP/SL thành công. Tiếp tục săn kèo!`, "success");
    } catch (e) { 
        addBotLog(`⚠️ Lỗi ghim TP/SL cho ${symbol}`, "error"); 
    } finally {
        status.isProcessing = false; // MỞ KHÓA CHO LỆNH TIẾP THEO
    }
}

// --- DỪNG KHẨN CẤP & ĐÓNG TẤT CẢ ---
async function emergencyStop() {
    botSettings.isRunning = false;
    addBotLog("🛑 DỪNG KHẨN CẤP! Đang dọn dẹp vị thế...", "error");
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
        addBotLog("✅ Đã đóng toàn bộ lệnh. Nghỉ ngơi thôi!", "success");
    } catch (e) { addBotLog("Lỗi khi đóng lệnh khẩn cấp.", "error"); }
}

// --- LUỒNG CHÍNH ---
async function hunt() {
    if (isInitializing || !botSettings.isRunning || status.isProcessing) return;

    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        // Xử lý SL Tài khoản (Cố định hoặc Trailing)
        if (status.startBalance === 0) { 
            status.startBalance = status.currentBalance; 
            status.highestBalance = status.currentBalance; 
        }
        
        if (botSettings.useTrailingSL && status.currentBalance > status.highestBalance) {
            status.highestBalance = status.currentBalance;
        }

        let threshold = botSettings.slUnit === 'percent' 
            ? status.highestBalance * (1 - botSettings.accountSL / 100) 
            : status.highestBalance - botSettings.accountSL;

        if (status.currentBalance <= threshold) {
            addBotLog(`🚨 CHẠM DỪNG LỖ TÀI KHOẢN ($${status.currentBalance.toFixed(2)})`, "error");
            return emergencyStop();
        }

        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
        if (active.length >= botSettings.maxPositions) return;

        // Quét tìm kèo
        for (const c of status.candidatesList) {
            if (active.some(p => p.symbol === c.symbol)) continue;

            status.isProcessing = true; // KHÓA LUỒNG
            addBotLog(`🎯 Vào lệnh ${c.symbol}...`);
            
            const info = status.exchangeInfo[c.symbol];
            const side = c.changePercent > 0 ? 'LONG' : 'SHORT';
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const price = parseFloat(ticker.price);
            
            // Tính số lượng (Qty) dựa trên đòn bẩy 20x mặc định
            const lev = 20;
            let qty = (botSettings.invValue * lev) / price;
            qty = Math.floor(qty / info.stepSize) * info.stepSize;

            if (qty <= 0) { status.isProcessing = false; continue; }

            try {
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: (side === 'LONG' ? 'BUY' : 'SELL'),
                    positionSide: side, type: 'MARKET', quantity: qty.toFixed(info.quantityPrecision)
                });
                
                // Đợi 3s để lệnh khớp rồi ghim TP/SL
                setTimeout(() => fastEnforce(c.symbol), 3000);
                break; // CHỈ MỞ 1 LỆNH MỖI CHU KỲ QUÉT
            } catch (err) {
                addBotLog(`Lỗi mở lệnh ${c.symbol}: ${err.msg}`, "error");
                status.isProcessing = false;
            }
        }
    } catch (e) { console.log("Lỗi Hunt:", e); }
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/live', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const all = JSON.parse(d);
                status.candidatesList = all
                    .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                    .sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
                    .slice(0, 5);
            } catch (e) {}
        });
    }).on('error', () => {});
}

// --- API ROUTES ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnlVal = parseFloat(p.unrealizedProfit);
            const pnlPct = (entry > 0) ? ((pnlVal / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnlPct, pnlValue: pnlVal };
        });
        res.json({ botSettings, status, activePositions: active, history });
    } catch (e) { res.status(500).json({ error: "Lỗi kết nối Binance" }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ status: "ok" });
});

APP.post('/api/stop-all', async (req, res) => {
    await emergencyStop();
    res.json({ status: "ok" });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                JSON.parse(d).symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { 
                        quantityPrecision: s.quantityPrecision, 
                        pricePrecision: s.pricePrecision, 
                        stepSize: parseFloat(lot.stepSize) 
                    };
                });
                isInitializing = false;
                addBotLog("🚢 HỆ THỐNG SẴN SÀNG RA KHƠI!", "success");
            } catch (e) { console.log("Lỗi Init:", e); }
        });
    });
}

init();
setInterval(fetchCandidates, 3000);
setInterval(hunt, 4000);
APP.listen(9001, '0.0.0.0');
