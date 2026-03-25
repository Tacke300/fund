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

// --- CONFIG BOT ---
let botSettings = { 
    isRunning: false, 
    maxPositions: 5, 
    invValue: 1.5, 
    invType: 'percent', 
    posTP: 1.0, 
    posSL: 3.0 
};

let status = { 
    currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [] 
};

let activeOrdersTracker = new Map(); 
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

// --- BINANCE API ENGINE ---
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
        const closeOrder = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: Math.abs(amount).toString()
        });
        
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        
        const data = activeOrdersTracker.get(symbol);
        if (data) {
            const exitPrice = parseFloat(closeOrder.avgPrice || 0);
            const pnlUsdt = posSide === 'LONG' ? (exitPrice - data.entryPrice) * amount : (data.entryPrice - exitPrice) * amount;
            
            // Cập nhật thống kê vĩnh viễn
            if (pnlUsdt > 0) tradeHistory.win++; else tradeHistory.loss++;
            tradeHistory.totalPnl += pnlUsdt;
            tradeHistory.orders.unshift({
                time: new Date().toLocaleString('vi-VN'),
                symbol,
                side: posSide,
                entry: data.entryPrice,
                exit: exitPrice,
                pnl: pnlUsdt.toFixed(2)
            });
            saveHistory();
            addBotLog(`✅ ĐÓNG ${symbol}: ${pnlUsdt > 0 ? '+' : ''}${pnlUsdt.toFixed(2)}$`, pnlUsdt > 0 ? "success" : "error");
        }
        activeOrdersTracker.delete(symbol);
    } catch (e) { addBotLog(`❌ Lỗi đóng ${symbol}: ${e.msg}`, "error"); }
}

// --- LOGIC MỞ LỆNH ---
async function openPosition(symbol, side, price, info) {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        let marginUSDT = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const leverage = brackets[0]?.brackets[0]?.initialLeverage || 20;
        
        let qty = (Math.floor(((marginUSDT * leverage) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        if (parseFloat(qty) * price < 5.1) return;

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) {
            const tpPrice = parseFloat((side === 'BUY' ? price * (1 + botSettings.posTP/100) : price * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision));
            const slPrice = parseFloat((side === 'BUY' ? price * (1 - botSettings.posSL/100) : price * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision));

            activeOrdersTracker.set(symbol, { entryPrice: price, side: posSide, tpPrice, slPrice });
            addBotLog(`🚀 MỞ: ${symbol} | ${posSide} ${leverage}x | Entry: ${price}`, "success");
        }
    } catch (e) { if (!e.msg?.includes("insufficient")) addBotLog(`❌ Lỗi ${symbol}: ${e.msg}`, "error"); }
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
            const isTP = (tracker.side === 'LONG' && mark >= tracker.tpPrice) || (tracker.side === 'SHORT' && mark <= tracker.tpPrice);
            const isSL = (tracker.side === 'LONG' && mark <= tracker.slPrice) || (tracker.side === 'SHORT' && mark >= tracker.slPrice);
            
            if (isTP || isSL) await forceCloseMarket(p.symbol, tracker.side, parseFloat(p.positionAmt));
        }

        if (activeInAcc.length < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (activeOrdersTracker.has(coin.symbol)) continue;
                const info = status.exchangeInfo[coin.symbol];
                if (info) {
                    await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', coin.price, info);
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
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk').catch(() => []);
        const top5 = [...status.candidatesList].sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1)).slice(0, 5);
        
        const active = posRisk.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const mark = parseFloat(p.markPrice);
            return {
                symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                leverage: p.leverage, entryPrice: entry, markPrice: mark,
                liqPrice: p.liquidationPrice, pnlPercent: ((p.unRealizedProfit / (p.positionInitialMargin || 1)) * 100).toFixed(2),
                pnlUsdt: parseFloat(p.unRealizedProfit).toFixed(2), margin: parseFloat(p.positionInitialMargin).toFixed(2),
                priceChange: entry !== 0 ? ((mark - entry) / entry * 100).toFixed(2) : 0
            };
        });
        res.json({ botSettings, activePositions: active, tradeHistory, top5, status });
    } catch (e) { res.status(500).send("ERR"); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

// Đồng bộ Scanner
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 3000);

setInterval(mainLoop, 2000);
APP.listen(9001, () => console.log("Hạm đội Luffy v2.1 Ready at 9001"));
