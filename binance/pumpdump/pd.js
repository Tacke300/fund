import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH GỐC ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0,
    accountSL: 30 
};

let status = { 
    currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [] 
};

let botManagedSymbols = []; // Danh sách symbol bot đang giữ lệnh
let pendingSymbols = new Set();

// --- HELPER: Ghi log chi tiết ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

// --- BINANCE API CALL ---
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

// --- LOGIC MỞ LỆNH VÀ CÀI TP/SL ---
async function openPosition(symbol, side, price, info) {
    try {
        // 1. Tính toán số dư và Margin
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        
        // 2. Lấy đòn bẩy tối đa cho symbol này
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const leverage = brackets[0].brackets[0].initialLeverage || 20;

        // 3. Tính khối lượng (Qty)
        let qty = (Math.floor(((margin * leverage) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        if (parseFloat(qty) <= 0) return;

        addBotLog(`🚀 Mở ${side}: ${symbol} | Lev: ${leverage}x | Margin: $${margin.toFixed(2)}`, "info");

        // 4. Đặt lệnh Market
        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) {
            botManagedSymbols.push(symbol);
            // Cài TP/SL (Ví dụ mặc định 1% ROI margin theo yêu cầu trước đó của bạn)
            const tpPrice = (side === 'BUY' ? price * 1.01 : price * 0.99).toFixed(info.pricePrecision);
            const slPrice = (side === 'BUY' ? price * 0.97 : price * 1.03).toFixed(info.pricePrecision);

            await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true', workingType: 'LAST_PRICE' });
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true', workingType: 'LAST_PRICE' });
            
            addBotLog(`✅ ${symbol} đã cài TP: ${tpPrice}, SL: ${slPrice}`, "success");
        }
    } catch (e) {
        addBotLog(`❌ Lỗi mở lệnh ${symbol}: ${e.msg || "API Error"}`, "error");
    }
}

// --- QUY TRÌNH CHÍNH ---
async function mainLoop() {
    if (!botSettings.isRunning) return;

    try {
        // Lấy vị thế thực tế từ sàn
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        // Cập nhật danh sách quản lý để cleanup
        botManagedSymbols = activePositions.map(p => p.symbol);

        if (activePositions.length >= botSettings.maxPositions) return;

        for (const coin of status.candidatesList) {
            if (botManagedSymbols.includes(coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            if (coin.maxV < botSettings.minVol) continue;

            const info = status.exchangeInfo[coin.symbol];
            if (!info) continue;

            pendingSymbols.add(coin.symbol);
            const side = coin.changePercent > 0 ? 'BUY' : 'SELL';
            
            // Lấy giá hiện tại
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: coin.symbol });
            await openPosition(coin.symbol, side, parseFloat(ticker.price), info);
            
            pendingSymbols.delete(coin.symbol);
            break; 
        }
    } catch (e) { addBotLog("Lỗi vòng lặp: " + (e.msg || "Mất kết nối"), "error"); }
}

// --- SERVER SETUP ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const active = posRisk.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol,
            side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            leverage: p.leverage,
            entryPrice: parseFloat(p.entryPrice).toFixed(4),
            markPrice: parseFloat(p.markPrice).toFixed(4),
            pnlPercent: ((parseFloat(p.unRealizedProfit) / parseFloat(p.isolatedWallet || 1)) * 100).toFixed(2)
        }));

        res.json({
            botSettings,
            activePositions: active,
            topVolatility: status.candidatesList.slice(0, 5),
            status: status
        });
    } catch (e) { res.json({ botSettings, activePositions: [], topVolatility: [], status }); }
});

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Cập nhật: Trạng thái=${botSettings.isRunning}, Max=${botSettings.maxPositions}`, "warn");
    res.json({ success: true });
});

// --- INIT DATA ---
async function init() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const prc = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                tickSize: parseFloat(prc.tickSize) 
            };
        });
        addBotLog("🤖 Bot System Online - Port 9001", "success");
    } catch (e) { console.log("Lỗi khởi tạo API"); }
}

// Lấy dữ liệu từ Server Port 9000
function fetchFromDataServer() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                status.candidatesList = (response.live || []).map(c => ({
                    symbol: c.symbol, 
                    c1: c.c1, c5: c.c5, c15: c.c15,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

init();
setInterval(fetchFromDataServer, 2000);
setInterval(mainLoop, 5000);

APP.listen(9001, '0.0.0.0', () => {
    console.log("Dashboard: http://localhost:9001");
});
