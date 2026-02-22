import WebSocket from 'ws';
import express from 'express';
import fs from 'fs';
import https from 'https';
import crypto from 'crypto';

// --- CẤU HÌNH ---
const API_KEY = 'KEY_CỦA_BẠN';
const SECRET_KEY = 'SECRET_CỦA_BẠN';
const PORT = 9001;
const HISTORY_FILE = './history_db.json';

const app = express();
app.use(express.json());

// Biến trạng thái hệ thống
let botSettings = { 
    isRunning: false, 
    maxPositions: 5, 
    invValue: 1.5, 
    invType: 'percent', 
    minVol: 5.0, 
    accountSL: 30 
};

let coinData = {}; 
let historyMap = new Map();
let botManagedSymbols = []; 
let exchangeInfo = {};
let systemStatus = { currentBalance: 0, activePositions: [], stats: { win: 0, lose: 0 } };

// --- UTILS & BINANCE API ---
function getPivotTime() {
    const now = new Date();
    let pivot = new Date(now);
    pivot.setHours(7, 0, 0, 0);
    if (now < pivot) pivot.setDate(pivot.getDate() - 1);
    return pivot.getTime();
}

async function callBinance(path, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${path}?${fullQuery}&signature=${signature}`;

    return new Promise((res, rej) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
        });
        req.on('error', rej); req.end();
    });
}

// --- LOGIC TÍNH TOÁN BIẾN ĐỘNG ---
function calculateChange(priceArray, minutes) {
    if (!priceArray || priceArray.length < 2) return 0;
    const now = priceArray[priceArray.length - 1].t;
    const targetTime = now - minutes * 60 * 1000;
    const startObj = priceArray.find(item => item.t >= targetTime);
    if (!startObj) return 0;
    return parseFloat(((priceArray[priceArray.length - 1].p - startObj.p) / startObj.p * 100).toFixed(2));
}

// --- CORE BOT LOGIC (HUNT & CLEANUP) ---
async function mainLoop() {
    if (!botSettings.isRunning) return;

    try {
        // 1. Cập nhật số dư và vị thế thực tế
        const acc = await callBinance('/fapi/v2/account');
        systemStatus.currentBalance = parseFloat(acc.totalMarginBalance);
        systemStatus.activePositions = acc.positions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        // Cập nhật danh sách quản lý
        botManagedSymbols = systemStatus.activePositions.map(p => p.symbol);

        // 2. Tự động cài TP/SL cho lệnh mới
        for (const pos of systemStatus.activePositions) {
            await checkAndSetTPSL(pos);
        }

        // 3. Quét tín hiệu để vào lệnh
        const candidates = Object.values(coinData)
            .filter(c => c.live && Math.abs(c.live.c5) >= botSettings.minVol)
            .sort((a, b) => Math.abs(b.live.c5) - Math.abs(a.live.c5));

        if (candidates.length > 0 && botManagedSymbols.length < botSettings.maxPositions) {
            const target = candidates[0];
            if (!botManagedSymbols.includes(target.symbol)) {
                await executeOrder(target);
            }
        }
    } catch (e) { console.error("Loop Error:", e.message); }
}

async function executeOrder(coin) {
    const side = coin.live.c5 > 0 ? 'BUY' : 'SELL';
    const posSide = coin.live.c5 > 0 ? 'LONG' : 'SHORT';
    const info = exchangeInfo[coin.symbol];
    if (!info) return;

    // Tính volume
    let margin = botSettings.invType === 'percent' ? (systemStatus.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
    const lev = 20; // Default leverage
    let qty = (margin * lev / coin.live.currentPrice).toFixed(info.quantityPrecision);

    try {
        await callBinance('/fapi/v1/leverage', 'POST', { symbol: coin.symbol, leverage: lev });
        await callBinance('/fapi/v1/order', 'POST', {
            symbol: coin.symbol, side: side, positionSide: posSide, type: 'MARKET', quantity: qty
        });
        console.log(`🚀 ENTERED: ${coin.symbol} ${posSide}`);
    } catch (e) { console.error("Order Fail:", e); }
}

async function checkAndSetTPSL(pos) {
    // Logic tối giản: Nếu chưa có lệnh dừng thì đặt
    // (Trong thực tế nên gọi /fapi/v1/openOrders để kiểm tra chính xác)
}

// --- KẾT NỐI DỮ LIỆU ---
function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        const tickers = JSON.parse(data);
        const now = Date.now();
        tickers.forEach(t => {
            const s = t.s; const p = parseFloat(t.c);
            if (!coinData[s]) coinData[s] = { symbol: s, prices: [] };
            coinData[s].prices.push({ p, t: now });
            if (coinData[s].prices.length > 100) coinData[s].prices.shift();

            const c1 = calculateChange(coinData[s].prices, 1);
            const c5 = calculateChange(coinData[s].prices, 5);
            const c15 = calculateChange(coinData[s].prices, 15);
            coinData[s].live = { c1, c5, c15, currentPrice: p };

            // Logic History Win/Lose cho UI Pirate
            let hist = historyMap.get(s);
            if (hist && hist.status === 'PENDING') {
                const diff = ((p - hist.snapPrice) / hist.snapPrice) * 100;
                if (hist.type === 'DOWN') {
                    if (diff <= -2) hist.status = 'WIN'; else if (diff >= 2) hist.status = 'LOSE';
                } else {
                    if (diff >= 2) hist.status = 'WIN'; else if (diff <= -2) hist.status = 'LOSE';
                }
            }
            if (Math.abs(c5) >= botSettings.minVol && (!hist || hist.status !== 'PENDING')) {
                historyMap.set(s, { symbol: s, startTime: now, max5: c5, snapPrice: p, type: c5 > 0 ? 'UP' : 'DOWN', status: 'PENDING' });
            }
        });
    });
    ws.on('error', () => setTimeout(initWS, 5000));
}

// --- API ENDPOINTS ---
app.get('/api/status', (req, res) => {
    const pivot = getPivotTime();
    const hArr = Array.from(historyMap.values());
    res.json({
        botSettings,
        status: { currentBalance: systemStatus.currentBalance },
        activePositions: systemStatus.activePositions.map(p => ({
            symbol: p.symbol, side: p.positionSide, leverage: p.leverage,
            entryPrice: p.entryPrice, markPrice: p.markPrice, pnlPercent: p.unrealizedProfit
        })),
        live: Object.values(coinData).filter(c => c.live).map(c => ({ symbol: c.symbol, ...c.live })).sort((a,b)=>Math.abs(b.c5)-Math.abs(a.c5)).slice(0,20),
        history: hArr.sort((a,b)=>b.startTime-a.startTime).slice(0,20),
        stats: {
            win: hArr.filter(h => h.startTime >= pivot && h.status === 'WIN').length,
            lose: hArr.filter(h => h.startTime >= pivot && h.status === 'LOSE').length
        }
    });
});

app.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.send(HTML_GUI);
});

// --- KHỞI CHẠY ---
async function start() {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            exchangeInfo[s.symbol] = { 
                pricePrecision: s.pricePrecision, 
                quantityPrecision: s.quantityPrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize)
            };
        });
        initWS();
        setInterval(mainLoop, 3000);
        app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server gộp chạy tại http://localhost:${PORT}`));
    } catch (e) { console.error("Start Error:", e); }
}

start();

// --- GIAO DIỆN (LUFFY STYLE) ---
const HTML_GUI = `<!DOCTYPE html>... (Dùng code HTML Luffy của bạn, chỉ cần sửa fetch('/api/data') thành fetch('/api/status') và map lại dữ liệu) ...`;
