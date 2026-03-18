import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH HỆ THỐNG ---
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

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0; // Biến fix lỗi lệch time

// --- HELPER: Ghi log chi tiết ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

// --- FIX LỖI TIME BINANCE ---
async function syncServerTime() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/time', res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const { serverTime } = JSON.parse(d);
                    serverTimeOffset = serverTime - Date.now();
                    resolve();
                } catch (e) { resolve(); }
            });
        }).on('error', () => resolve());
    });
}

// --- BINANCE API CALL CHUẨN ---
async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() + serverTimeOffset;
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
                } catch (e) { reject({ msg: j.msg || "API_ERR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- LOGIC MỞ LỆNH ---
async function openPosition(symbol, side, price, info) {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        let marginUSDT = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const leverage = brackets[0]?.brackets[0]?.initialLeverage || 20;

        let rawQty = (marginUSDT * leverage) / price;
        let qty = (Math.floor(rawQty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        if (parseFloat(qty) <= 0) {
            addBotLog(`⚠️ Vốn $${marginUSDT.toFixed(2)} quá thấp để mở ${symbol}`, "warn");
            return;
        }

        addBotLog(`🚀 Mở ${side} ${symbol} | Vốn: $${marginUSDT.toFixed(2)} | Lev: ${leverage}x | Qty: ${qty}`, "info");

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) {
            const tpPrice = (side === 'BUY' ? price * 1.01 : price * 0.99).toFixed(info.pricePrecision);
            const slPrice = (side === 'BUY' ? price * 0.97 : price * 1.03).toFixed(info.pricePrecision);

            await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true', workingType: 'LAST_PRICE' });
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true', workingType: 'LAST_PRICE' });
            
            addBotLog(`✅ Đã mở ${symbol}. Entry: ${price} | TP: ${tpPrice} | SL: ${slPrice}`, "success");
            activeOrdersTracker.set(symbol, { entryPrice: price, margin: marginUSDT, side: posSide });
        }
    } catch (e) {
        addBotLog(`❌ Lỗi mở lệnh ${symbol}: ${e.msg || "API Error"}`, "error");
    }
}

// --- THEO DÕI LỆNH ĐÓNG ---
async function trackClosedPositions() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        const newBal = parseFloat(acc.totalMarginBalance);

        for (const [symbol, data] of activeOrdersTracker) {
            const posRisk = await callBinance('/fapi/v2/positionRisk', 'GET', { symbol });
            const currentPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side);

            if (!currentPos || parseFloat(currentPos.positionAmt) === 0) {
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.sort((a,b) => b.time - a.time)[0];
                if (lastTrade) {
                    const pnl = parseFloat(lastTrade.realizedPnl);
                    const type = pnl >= 0 ? "CHẠM TP (LÃI)" : "CHẠM SL (LỖ)";
                    addBotLog(`🔔 ĐÓNG LỆNH ${symbol}: ${type} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT | Số dư mới: $${newBal.toFixed(2)}`, pnl >= 0 ? "success" : "error");
                    activeOrdersTracker.delete(symbol);
                }
            }
        }
        status.currentBalance = newBal;
    } catch (e) {}
}

// --- VÒNG LẶP CHÍNH ---
async function mainLoop() {
    if (!botSettings.isRunning) return;

    try {
        await syncServerTime(); 
        await trackClosedPositions(); 

        const positions = await callBinance('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0);
        
        if (activePositions.length >= botSettings.maxPositions) return;

        for (const coin of status.candidatesList) {
            const isAlreadyOpen = activePositions.some(p => p.symbol === coin.symbol);
            if (isAlreadyOpen || pendingSymbols.has(coin.symbol)) continue;
            if (coin.maxV < botSettings.minVol) continue;

            const info = status.exchangeInfo[coin.symbol];
            if (!info) continue;

            pendingSymbols.add(coin.symbol);
            const side = coin.c1 >= 0 ? 'BUY' : 'SELL';
            
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: coin.symbol });
            await openPosition(coin.symbol, side, parseFloat(ticker.price), info);
            
            pendingSymbols.delete(coin.symbol);
            break; 
        }
    } catch (e) { addBotLog("Lỗi quét: " + (e.msg || "Mất kết nối"), "error"); }
}

// --- API ENDPOINTS ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const active = posRisk.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
            symbol: p.symbol,
            side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            leverage: p.leverage,
            entryPrice: parseFloat(p.entryPrice).toFixed(status.exchangeInfo[p.symbol]?.pricePrecision || 4),
            markPrice: parseFloat(p.markPrice).toFixed(status.exchangeInfo[p.symbol]?.pricePrecision || 4),
            pnlPercent: ((parseFloat(p.unRealizedProfit) / (parseFloat(p.isolatedWallet) || 1)) * 100).toFixed(2)
        }));

        res.json({ botSettings, activePositions: active, topVolatility: status.candidatesList.slice(0, 5), status });
    } catch (e) { res.json({ botSettings, activePositions: [], topVolatility: [], status }); }
});

APP.post('/api/settings', async (req, res) => {
    const wasRunning = botSettings.isRunning;
    botSettings = { ...botSettings, ...req.body };
    
    if (!wasRunning && botSettings.isRunning) {
        await syncServerTime();
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        addBotLog(`▶️ BẮT ĐẦU. Số dư: $${status.currentBalance.toFixed(2)} USDT`, "warn");
    } else if (wasRunning && !botSettings.isRunning) {
        addBotLog(`⏸️ ĐÃ DỪNG BOT.`, "warn");
    } else {
        addBotLog(`⚙️ Đã cập nhật cấu hình.`, "info");
    }
    res.json({ success: true });
});

// --- KHỞI TẠO ---
async function init() {
    await syncServerTime();
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
        addBotLog("🤖 Hệ thống Online. Sẵn sàng quét kèo!", "success");
    } catch (e) { addBotLog("❌ Không thể lấy ExchangeInfo", "error"); }
}

// Fetch từ Port 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                status.candidatesList = (response.live || []).map(c => ({
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

init();
setInterval(mainLoop, 4000);
APP.listen(9001, '0.0.0.0', () => console.log("Bot 9001 Running..."));
