import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH ---
let tpPercent = 1.0; 
let slPercent = 3.0; 
let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };

let botManagedSymbols = []; 
let pendingSymbols = new Set();
let missingCount = new Map();

// --- HELPER FUNCTIONS ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
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
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); 
                    else reject(j);
                } catch (e) { reject({ msg: "PARSE_ERR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

async function tryOrder(params) {
    try { return await callBinance('/fapi/v1/order', 'POST', params); } 
    catch (e) { return { error: e.msg || e.code || "UNKNOWN_ERR" }; }
}

// --- HÀM BẢO VỆ ---
async function enforceBaoVe(symbol, side, type, price) {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const orderType = type === 'TP' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET';
    
    let res = await tryOrder({
        symbol,
        side: closeSide,
        positionSide: side,
        type: orderType,
        stopPrice: price,
        workingType: 'LAST_PRICE',
        closePosition: 'true'
    });

    if (!res.error) {
        addBotLog(`✅ [${symbol}] ${type} OK tại ${price}`, "success");
        return true;
    }
    addBotLog(`❌ [${symbol}] Lỗi cài ${type}: ${res.error}`, "error");
    return false;
}

// --- HÀM HUNT ---
async function hunt() {
    if (status.candidatesList.length === 0 || !botSettings.isRunning) return;
    if (botManagedSymbols.length >= botSettings.maxPositions) return;

    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        for (const c of status.candidatesList.filter(c => c.maxV >= botSettings.minVol)) {
            if (activeOnExchange.includes(c.symbol) || botManagedSymbols.includes(c.symbol) || pendingSymbols.has(c.symbol)) continue;

            const info = status.exchangeInfo[c.symbol];
            if (!info) continue;

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const currentPrice = parseFloat(ticker.price);
            
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            let qty = (Math.floor(((margin * 50) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            if (parseFloat(qty) <= 0) continue;

            pendingSymbols.add(c.symbol);
            addBotLog(`🎯 MỞ LỆNH: ${c.symbol} | Giá: ${currentPrice}`, "info");

            const side = c.changePercent > 0 ? 'BUY' : 'SELL';
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

            const order = await tryOrder({ symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

            if (order.orderId) {
                botManagedSymbols.push(c.symbol);
                await new Promise(r => setTimeout(r, 2000));
                
                const pCheck = await callBinance('/fapi/v2/positionRisk');
                const p = pCheck.find(pos => pos.symbol === c.symbol && parseFloat(pos.positionAmt) !== 0);
                
                if (p) {
                    const entry = parseFloat(p.entryPrice);
                    const tpP = (Math.round((posSide === 'LONG' ? entry * (1 + tpPercent / 100) : entry * (1 - tpPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
                    const slP = (Math.round((posSide === 'LONG' ? entry * (1 - slPercent / 100) : entry * (1 + slPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);

                    await enforceBaoVe(c.symbol, posSide, 'TP', tpP);
                    await enforceBaoVe(c.symbol, posSide, 'SL', slP);
                }
            }
            pendingSymbols.delete(c.symbol);
            break; 
        }
    } catch (e) { pendingSymbols.clear(); }
}

// --- HÀM CLEANUP ---
async function cleanup() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            if (pendingSymbols.has(s)) continue;

            if (!activeOnExchange.includes(s)) {
                let count = (missingCount.get(s) || 0) + 1;
                missingCount.set(s, count);

                if (count >= 3) {
                    addBotLog(`🏁 [${s}] Đã đóng. Dọn dẹp...`, "warn");
                    await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                    botManagedSymbols.splice(i, 1);
                    missingCount.delete(s);
                }
            } else {
                missingCount.set(s, 0);
            }
        }
    } catch (e) {}
}

// --- SERVER & ROUTES (FIXED) ---
const APP = express();
APP.use(express.json());

// Phục vụ các file tĩnh (CSS, JS) cùng thư mục
APP.use(express.static(__dirname));

// Route chính trả về index.html
APP.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API cập nhật trạng thái
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        res.json({ botSettings, botRunningSlots: botManagedSymbols, status });
    } catch (e) { 
        res.status(500).json({ error: "ERR_API" }); 
    }
});

// API nhận lệnh update setting từ UI
APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog("⚙️ Đã cập nhật cài đặt từ UI", "warn");
    res.json({ success: true });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
            info.symbols.forEach(s => {
                const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const prc = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), tickSize: parseFloat(prc.tickSize) };
            });
            addBotLog("🚀 HỆ THỐNG SẴN SÀNG", "success");
        });
    });
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                status.candidatesList = (response.live || []).map(c => ({
                    symbol: c.symbol, changePercent: c.c1, maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

init();
setInterval(fetchCandidates, 2000);
setInterval(hunt, 4000);
setInterval(cleanup, 8000);

// Chạy server tại port 9001
const PORT = 9001;
APP.listen(PORT, '0.0.0.0', () => {
    console.log(`\n\x1b[32m[SERVER] Dashboard: http://localhost:${PORT}\x1b[0m\n`);
});
