import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'trade_history.json');

// --- KHỞI TẠO DỮ LIỆU LỊCH SỬ VĨNH VIỄN ---
let tradeHistory = { win: 0, loss: 0, totalPnl: 0, orders: [] };
if (fs.existsSync(HISTORY_FILE)) {
    try {
        tradeHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {
        console.log("Lỗi đọc file lịch sử, khởi tạo mới.");
    }
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));
}

// --- CẤU HÌNH BOT CHUẨN ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 5, 
    invValue: 1.5, 
    invType: 'percent', 
    posTP: 1.0, 
    posSL: 3.0,
    botSLValue: 50.0, // Giá trị SL Bot
    botSLType: 'fixed' // 'fixed' là $ hoặc 'percent' là %
};

let status = { 
    currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [] 
};

let activeOrdersTracker = new Map(); 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

// --- BINANCE API ENGINE ---
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
                    resolve(j);
                } catch (e) { reject({ msg: "JSON_ERR" }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- LOGIC ĐÓNG LỆNH & LƯU LỊCH SỬ ---
async function forceCloseMarket(symbol, posSide, amount) {
    try {
        const side = posSide === 'LONG' ? 'SELL' : 'BUY';
        const res = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: Math.abs(amount).toString()
        });
        
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        
        const data = activeOrdersTracker.get(symbol);
        if (data && res.orderId) {
            const exitPrice = parseFloat(res.avgPrice || 0);
            const pnlUsdt = posSide === 'LONG' ? (exitPrice - data.entryPrice) * amount : (data.entryPrice - exitPrice) * amount;
            
            if (pnlUsdt > 0) tradeHistory.win++; else tradeHistory.loss++;
            tradeHistory.totalPnl += pnlUsdt;
            tradeHistory.orders.unshift({
                openTime: data.openTime,
                closeTime: new Date().toLocaleString('vi-VN'),
                symbol, side: posSide, lev: data.leverage,
                entry: data.entryPrice, exit: exitPrice,
                pnl: pnlUsdt.toFixed(2),
                snapshot: data.snapshot
            });
            saveHistory();
            addBotLog(`✅ ĐÓNG ${symbol}: ${pnlUsdt.toFixed(2)}$`, pnlUsdt > 0 ? "success" : "error");
        }
        activeOrdersTracker.delete(symbol);
    } catch (e) { addBotLog(`❌ Lỗi đóng ${symbol}`, "error"); }
}

// --- LOGIC MỞ LỆNH VỚI MAX LEVERAGE ---
async function openPosition(symbol, side, price, info, scanData) {
    try {
        // TỰ ĐỘNG SET MAX LEVERAGE
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const maxLev = brackets[0]?.brackets[0]?.initialLeverage || 20;
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: maxLev });

        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        
        let qty = (Math.floor(((margin * maxLev) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        if (parseFloat(qty) * price < 5.1) return;

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) {
            activeOrdersTracker.set(symbol, {
                entryPrice: price, side: posSide, leverage: maxLev,
                openTime: new Date().toLocaleString('vi-VN'),
                snapshot: { m1: scanData.c1, m5: scanData.c5, m15: scanData.c15 },
                tpPrice: side === 'BUY' ? price * (1 + botSettings.posTP/100) : price * (1 - botSettings.posTP/100),
                slPrice: side === 'BUY' ? price * (1 - botSettings.posSL/100) : price * (1 + botSettings.posSL/100)
            });
            addBotLog(`🚀 MỞ: ${symbol} ${posSide} ${maxLev}x`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi mở ${symbol}`, "error"); }
}

// --- LOGIC SL BOT (TÍCH LŨY $ HOẶC %) ---
async function checkBotSL() {
    if (!botSettings.isRunning) return;
    try {
        const pos = await callBinance('/fapi/v2/positionRisk');
        const currentUnrealized = pos.reduce((acc, p) => acc + parseFloat(p.unRealizedProfit || 0), 0);
        
        let isPanic = false;
        if (botSettings.botSLType === 'fixed') {
            if (currentUnrealized <= (botSettings.botSLValue * -1)) isPanic = true;
        } else {
            const threshold = (status.currentBalance * botSettings.botSLValue) / 100;
            if (currentUnrealized <= (threshold * -1)) isPanic = true;
        }

        if (isPanic) {
            const active = pos.filter(p => parseFloat(p.positionAmt) !== 0);
            for (const p of active) {
                await callBinance('/fapi/v1/order', 'POST', {
                    symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'SELL' : 'BUY',
                    positionSide: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                    type: 'MARKET', quantity: Math.abs(p.positionAmt).toString()
                });
            }
            botSettings.isRunning = false;
            addBotLog("🛑 SL BOT ACTIVATED: DỪNG TOÀN BỘ HẠM ĐỘI!", "error");
        }
    } catch (e) {}
}

// --- VÒNG LẶP CHÍNH ---
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activeInAcc = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
        
        for (const p of activeInAcc) {
            const tracker = activeOrdersTracker.get(p.symbol);
            if (!tracker) continue;
            const mark = parseFloat(p.markPrice);
            if ((tracker.side === 'LONG' && (mark >= tracker.tpPrice || mark <= tracker.slPrice)) || 
                (tracker.side === 'SHORT' && (mark <= tracker.tpPrice || mark >= tracker.slPrice))) {
                await forceCloseMarket(p.symbol, tracker.side, parseFloat(p.positionAmt));
            }
        }

        if (activeInAcc.length < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (activeOrdersTracker.has(coin.symbol)) continue;
                const info = status.exchangeInfo[coin.symbol];
                if (info) {
                    await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', coin.price, info, coin);
                    break; 
                }
            }
        }
    } catch (e) {}
}

// --- SERVER API ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const posRisk = await callBinance('/fapi/v2/positionRisk').catch(() => []);
    const active = posRisk.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
        const trk = activeOrdersTracker.get(p.symbol) || { snapshot: {m1:0,m5:0,m15:0} };
        return { symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT', lev: p.leverage, entry: p.entryPrice, mark: p.markPrice, pnlUsdt: p.unRealizedProfit, snapshot: trk.snapshot };
    });
    res.json({ botSettings, activePositions: active, tradeHistory, status });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

// Scanner & Intervals
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 2000);

setInterval(mainLoop, 2000);
setInterval(checkBotSL, 2000);

// Khởi chạy
const info = await callBinance('/fapi/v1/exchangeInfo');
info.symbols.forEach(s => {
    const f = s.filters.find(f => f.filterType === 'LOT_SIZE');
    const p = s.filters.find(f => f.filterType === 'PRICE_FILTER');
    status.exchangeInfo[s.symbol] = {
        stepSize: parseFloat(f.stepSize),
        quantityPrecision: s.quantityPrecision,
        pricePrecision: s.pricePrecision,
        tickSize: parseFloat(p.tickSize)
    };
});

APP.listen(9001, () => console.log("Hạm đội Luffy v3.0 Ready"));
