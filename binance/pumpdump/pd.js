import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); else reject(j);
                } catch (e) { reject({ msg: "API_REJECT" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// HÀM LUÔN CHẠY: Cập nhật thông tin từ Server 9000 bất kể Bot Start hay Stop
function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                const all = response.live || [];
                
                // Lọc coin biến động để hiển thị lên bảng Top/Candidates
                const filtered = all.filter(c => 
                    Math.abs(c.c1) >= botSettings.minVol || 
                    Math.abs(c.c5) >= botSettings.minVol || 
                    Math.abs(c.c15) >= botSettings.minVol
                );

                // Cập nhật danh sách ứng viên liên tục để giao diện hiển thị
                status.candidatesList = filtered.map(c => {
                    let triggerFrame = "1M", changePercent = c.c1;
                    if (Math.abs(c.c5) >= botSettings.minVol) { triggerFrame = "5M"; changePercent = c.c5; }
                    else if (Math.abs(c.c15) >= botSettings.minVol) { triggerFrame = "15M"; changePercent = c.c15; }
                    return { symbol: c.symbol, changePercent, triggerFrame, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15)) };
                }).sort((a, b) => b.maxV - a.maxV).slice(0, 10);

                // Log thông báo mỗi khi quét thấy tín hiệu mới (kể cả khi chưa Start bot)
                if (filtered.length > 0) {
                    // Chỉ log 1 dòng đại diện để tránh spam terminal
                    const top = status.candidatesList[0];
                    addBotLog(`📡 Nhận dữ liệu: ${filtered.length} mã biến động. Cao nhất: ${top.symbol} ${top.maxV}%`, "debug");
                }
            } catch (e) {
                // addBotLog("❌ Lỗi xử lý JSON từ Server 9000", "error");
            }
        });
    }).on('error', () => {
        addBotLog("⚠️ Không kết nối được Server 9000 (Kiểm tra lại server tín hiệu)", "error");
    });
}

async function hunt() {
    // Chỉ khi nhấn START (botSettings.isRunning = true) mới chạy logic đặt lệnh
    if (isInitializing || !botSettings.isRunning || isProcessing) return;
    
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();

        for (const c of status.candidatesList) {
            const hasPos = positions.find(p => p.symbol === c.symbol && parseFloat(p.positionAmt) !== 0);
            if (hasPos) {
                if (!botManagedSymbols.includes(c.symbol)) botManagedSymbols.push(c.symbol);
                continue;
            }

            if (blockedSymbols.has(c.symbol)) {
                if (now < blockedSymbols.get(c.symbol)) continue;
                blockedSymbols.delete(c.symbol);
            }

            if (botManagedSymbols.length >= botSettings.maxPositions) break;

            try {
                addBotLog(`🚀 ĐỦ ĐIỀU KIỆN - VÀO LỆNH: ${c.symbol}`, "success");
                
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                
                const acc = await callBinance('/fapi/v2/account');
                status.currentBalance = parseFloat(acc.totalMarginBalance);
                
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const price = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                
                const side = c.changePercent > 0 ? 'BUY' : 'SELL';
                const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                if ((margin * lev) < 5.5) margin = 6.0 / lev;
                
                let qty = Math.floor(((margin * lev) / price) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: finalQty
                });

                botManagedSymbols.push(c.symbol);
                addBotLog(`✅ Khớp lệnh ${posSide} ${c.symbol}`, "success");
                setTimeout(() => enforceTPSL(), 3000);
            } catch (err) {
                addBotLog(`❌ Lỗi đặt lệnh ${c.symbol}`, "error");
            }
        }
    } catch (e) {
    } finally {
        isProcessing = false;
    }
}

async function cleanupClosedPositions() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            const p = positions.find(pos => pos.symbol === s);
            if (!p || parseFloat(p.positionAmt) === 0) {
                addBotLog(`🏁 Đã đóng ${s}. Block 15 phút.`, "warn");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                blockedSymbols.set(s, now + 15 * 60 * 1000);
                botManagedSymbols.splice(i, 1);
            }
        }
    } catch (e) {}
}

async function enforceTPSL() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const orders = await callBinance('/fapi/v1/openOrders');
        for (const s of botManagedSymbols) {
            const p = positions.find(pos => pos.symbol === s && parseFloat(pos.positionAmt) !== 0);
            if (!p) continue;
            const side = p.positionSide;
            const entry = parseFloat(p.entryPrice);
            const hasTP = orders.some(o => o.symbol === s && o.positionSide === side && o.type === 'TAKE_PROFIT_MARKET');
            const hasSL = orders.some(o => o.symbol === s && o.positionSide === side && o.type === 'STOP_MARKET');
            
            if (!hasTP || !hasSL) {
                const info = status.exchangeInfo[s];
                let m = p.leverage < 26 ? 1.11 : 2.22;
                const rate = m / p.leverage;
                const tp = side === 'LONG' ? entry * (1 + rate) : entry * (1 - rate);
                const sl = side === 'LONG' ? entry * (1 - rate) : entry * (1 + rate);
                const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

                if (!hasTP) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: tp.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                if (!hasSL) await callBinance('/fapi/v1/order', 'POST', { symbol: s, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: sl.toFixed(info.pricePrecision), closePosition: 'true', workingType: 'MARK_PRICE' });
                addBotLog(`🎯 Cài đặt TP/SL cho ${s}`, "debug");
            }
        }
    } catch (e) {}
}

const APP = express();
APP.use(express.json());

APP.get('/api/status', async (req, res) => {
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const active = pos.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = (entry > 0) ? ((parseFloat(p.unrealizedProfit) / ((entry * amt) / p.leverage)) * 100).toFixed(2) : "0.00";
            return { symbol: p.symbol, side: p.positionSide, leverage: p.leverage, entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: pnl };
        });
        res.json({ botSettings, status, activePositions: active });
    } catch (e) { res.status(500).json({ error: "ERR" }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Cập nhật: ${botSettings.isRunning ? "RUNNING" : "STOPPED"}`, "warn");
    res.json({ status: "ok" });
});

async function init() {
    addBotLog("🔄 Đang khởi tạo dữ liệu sàn...", "info");
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            try {
                const info = JSON.parse(d);
                info.symbols.forEach(s => {
                    const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                    status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
                });
                isInitializing = false;
                addBotLog("✅ Hệ thống sẵn sàng!", "success");
            } catch (e) { }
        });
    });
}

init();
setInterval(fetchCandidates, 3000); // LUÔN CHẠY để lấy data
setInterval(hunt, 2000);             // Chỉ đặt lệnh khi isRunning = true
setInterval(cleanupClosedPositions, 5000);
setInterval(enforceTPSL, 15000);
APP.listen(9001, '0.0.0.0');
