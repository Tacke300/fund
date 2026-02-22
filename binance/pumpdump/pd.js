import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- CẤU HÌNH ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let isInitializing = true;
let isProcessing = false;

// Quản lý thời gian nghỉ và Log
let coinCooldowns = new Map(); // { SYMBOL: timestamp_close }
let lastLogMessage = ""; // Lưu log cuối cùng để chặn lặp

// --- HÀM LOG CHỐNG SPAM ---
function addBotLog(msg, type = 'info') {
    // Nếu tin nhắn giống hệt tin trước đó thì bỏ qua (chặn spam log quét tín hiệu)
    if (msg === lastLogMessage) return;
    lastLogMessage = msg;

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();

    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || colors.info}[${time}] [${type.toUpperCase()}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY }, timeout: 8000 }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "LỖI_JSON" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// 1. DỌN DẸP VỊ THẾ & LỆNH CHỜ (CẬP NHẬT: THÊM COOLDOWN 15P)
async function cleanupClosedPositions() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const symbol = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === symbol);
            
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🧹 [ĐÓNG] ${symbol} đã thoát vị thế. Bắt đầu nghỉ 15 phút.`, "info");
                
                // Lưu thời điểm đóng để bắt đầu tính 15p nghỉ
                coinCooldowns.set(symbol, now);

                // Xóa lệnh chờ (TP/SL mồ côi)
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
                
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) { /* Giảm log lỗi API */ }
}

// 2. TÍNH TOÁN & CÀI TP/SL
function calcTPSL(lev, side, entryPrice) {
    let m = lev < 26 ? 1.11 : (lev < 50 ? 2.22 : 3.33);
    const rate = m / lev;
    return {
        tp: side === 'LONG' ? entryPrice * (1 + rate) : entryPrice * (1 - rate),
        sl: side === 'LONG' ? entryPrice * (1 - rate) : entryPrice * (1 + rate)
    };
}

async function enforceTPSL() {
    if (!botSettings.isRunning) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');

        for (const symbol of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;

            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            if (entry <= 0) continue;

            const hasTP = orders.some(o => o.symbol === symbol && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === symbol && o.type === 'STOP_MARKET');

            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[symbol];
                const plan = calcTPSL(parseFloat(p.leverage), side, entry);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET',
                        stopPrice: plan.tp.toFixed(info.pricePrecision), closePosition: 'true', timeInForce: 'GTC', workingType: 'MARK_PRICE'
                    });
                }
                if (!hasSL) {
                    await callBinance('/fapi/v1/order', 'POST', {
                        symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET',
                        stopPrice: plan.sl.toFixed(info.pricePrecision), closePosition: 'true', timeInForce: 'GTC', workingType: 'MARK_PRICE'
                    });
                }
                addBotLog(`🎯 [TP/SL] Đã cài đặt bảo vệ cho ${symbol}`, "success");
            }
        }
    } catch (e) {}
}

// 3. HÀM SĂN LỆNH (CẬP NHẬT: XÓA LỆNH CHỜ TRƯỚC KHI MỞ)
async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing) return;

    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) {
            addBotLog(`💤 Đang giữ ${botManagedSymbols.length} lệnh. Chờ slot...`, "debug");
            return;
        }

        for (const c of status.candidatesList) {
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                addBotLog(`🚀 [VÀO LỆNH] Phát hiện tín hiệu: ${c.symbol}`, "info");

                // BƯỚC 1: Xóa lệnh chờ cũ nếu có
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(() => {});

                // BƯỚC 2: Set đòn bẩy
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });

                // BƯỚC 3: Tính toán khối lượng
                const acc = await callBinance('/fapi/v2/account');
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const info = status.exchangeInfo[c.symbol];
                
                let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalMarginBalance) * botSettings.invValue) / 100 : botSettings.invValue;
                let qty = (margin * lev) / parseFloat(ticker.price);
                const finalQty = (Math.floor(qty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

                const side = (c.c1 >= botSettings.minVol || c.c5 >= botSettings.minVol || c.c15 >= botSettings.minVol) ? 'BUY' : 'SELL';
                const posSide = side === 'BUY' ? 'LONG' : 'SHORT';

                // BƯỚC 4: Đặt lệnh Market
                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: finalQty
                });

                botManagedSymbols.push(c.symbol);
                addBotLog(`✅ Mở thành công ${posSide} ${c.symbol}`, "success");
                
                // Đợi 2s rồi cài TP/SL
                setTimeout(enforceTPSL, 2000);

            } catch (err) {
                addBotLog(`❌ Lỗi vào lệnh ${c.symbol}: ${err.msg || "API"}`, "error");
            }
        }
    } finally {
        isProcessing = false;
    }
}

// 4. LẤY TÍN HIỆU (CẬP NHẬT: CHECK 1-5-15 VÀ COOLDOWN)
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const raw = JSON.parse(d);
                const now = Date.now();
                const all = raw.live || [];

                const filtered = all.filter(c => {
                    // Kiểm tra Ngủ 15 phút
                    if (coinCooldowns.has(c.symbol)) {
                        if (now - coinCooldowns.get(c.symbol) < 15 * 60 * 1000) return false;
                        else coinCooldowns.delete(c.symbol); // Hết hạn nghỉ
                    }

                    // Điều kiện 1 trong 3 mốc đủ minVol
                    return Math.abs(c.c1) >= botSettings.minVol || 
                           Math.abs(c.c5) >= botSettings.minVol || 
                           Math.abs(c.c15) >= botSettings.minVol;
                });

                status.candidatesList = filtered.sort((a,b) => Math.abs(b.c5) - Math.abs(a.c5)).slice(0, 5);
                
                if (botSettings.isRunning && status.candidatesList.length > 0) {
                    addBotLog(`📡 Tín hiệu mới: ${status.candidatesList.map(x => x.symbol).join(', ')}`, "debug");
                } else {
                    addBotLog("📡 Đang quét tín hiệu 1m/5m/15m...", "debug");
                }
            } catch (e) {}
        });
    }).on('error', () => addBotLog("📡 Lỗi kết nối cổng 9000", "error"));
}

// --- KHỞI CHẠY ---
const APP = express();
APP.use(express.json());

APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol, side: p.positionSide, pnl: p.unrealizedProfit
        }));
        res.json({ botSettings, activePositions: active, botManagedSymbols });
    } catch (e) { res.status(500).send(); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Cập nhật cấu hình: isRunning=${botSettings.isRunning}`, "warn");
    res.json({ status: "ok" });
});

async function init() {
    addBotLog("🔧 Đang đồng bộ dữ liệu sàn...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                status.exchangeInfo[s.symbol] = { 
                    quantityPrecision: s.quantityPrecision, 
                    pricePrecision: s.pricePrecision, 
                    stepSize: parseFloat(lot.stepSize) 
                };
            });
            isInitializing = false;
            addBotLog("✅ Bot đã sẵn sàng.", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 3000);  
setInterval(hunt, 2000);            
setInterval(cleanupClosedPositions, 5000); 
setInterval(enforceTPSL, 10000);     

APP.listen(9001, '0.0.0.0');
