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

// Khởi tạo lịch sử vĩnh viễn
let tradeHistory = { win: 0, loss: 0, totalPnl: 0, orders: [] };
if (fs.existsSync(HISTORY_FILE)) {
    try { tradeHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { console.error("Lỗi đọc history"); }
}

const saveHistory = () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));

// Cấu hình đầy đủ thông số
let botSettings = { 
    isRunning: false, 
    maxPositions: 5, 
    invValue: 1.5, 
    invType: 'percent', 
    posTP: 1.0, 
    posSL: 3.0,
    leverage: 20,
    minVolume: 5.1 // Binance tối thiểu ~5 USDT
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
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
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on('error', e => reject(e));
        req.end();
    });
}

async function forceCloseMarket(symbol, posSide, amount) {
    try {
        const side = posSide === 'LONG' ? 'SELL' : 'BUY';
        const res = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: Math.abs(amount).toString() });
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        
        const data = activeOrdersTracker.get(symbol);
        if (data && res.orderId) {
            const exitPrice = parseFloat(res.avgPrice || 0);
            const pnl = posSide === 'LONG' ? (exitPrice - data.entryPrice) * amount : (data.entryPrice - exitPrice) * amount;
            
            if (pnl > 0) tradeHistory.win++; else tradeHistory.loss++;
            tradeHistory.totalPnl += pnl;
            tradeHistory.orders.unshift({
                openTime: data.openTime,
                closeTime: new Date().toLocaleString('vi-VN'),
                symbol, side: posSide, lev: data.leverage,
                entry: data.entryPrice, exit: exitPrice,
                tp: data.tpPrice, sl: data.slPrice,
                pnl: pnl.toFixed(2),
                snapshot: data.snapshot // Lưu biến động 3 khung lúc mở lệnh
            });
            saveHistory();
            addBotLog(`✅ ĐÓNG ${symbol}: ${pnl.toFixed(2)}$`, pnl > 0 ? "success" : "error");
        }
        activeOrdersTracker.delete(symbol);
    } catch (e) { addBotLog(`❌ Lỗi đóng ${symbol}`, "error"); }
}

async function openPosition(symbol, side, price, info, scannerData) {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        
        let qty = (Math.floor(((margin * botSettings.leverage) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        if (parseFloat(qty) * price < botSettings.minVolume) return;

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const res = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

        if (res.orderId) {
            const tp = parseFloat((side === 'BUY' ? price * (1 + botSettings.posTP/100) : price * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision));
            const sl = parseFloat((side === 'BUY' ? price * (1 - botSettings.posSL/100) : price * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision));
            
            activeOrdersTracker.set(symbol, {
                entryPrice: price, side: posSide, tpPrice: tp, slPrice: sl,
                openTime: new Date().toLocaleString('vi-VN'), leverage: botSettings.leverage,
                snapshot: { m1: scannerData.c1, m5: scannerData.c5, m15: scannerData.c15 }
            });
            addBotLog(`🚀 MỞ: ${symbol} ${posSide} ${botSettings.leverage}x`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi mở lệnh ${symbol}`, "error"); }
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const posRisk = await callBinance('/fapi/v2/positionRisk').catch(() => []);
    const active = posRisk.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
        const tracker = activeOrdersTracker.get(p.symbol) || {};
        return {
            symbol: p.symbol, side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
            leverage: p.leverage, entry: p.entryPrice, mark: p.markPrice, liq: p.liquidationPrice,
            pnlPer: ((p.unRealizedProfit / (p.positionInitialMargin || 1)) * 100).toFixed(2),
            pnlUsdt: parseFloat(p.unRealizedProfit).toFixed(2),
            tp: tracker.tpPrice || 0, sl: tracker.slPrice || 0,
            snapshot: tracker.snapshot || { m1: 0, m5: 0, m15: 0 }
        };
    });
    res.json({ botSettings, activePositions: active, tradeHistory, candidates: status.candidatesList.slice(0, 5), status });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 2000);

setInterval(async () => {
    if (!botSettings.isRunning) return;
    const posRisk = await callBinance('/fapi/v2/positionRisk').catch(() => []);
    const activeInAcc = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
    
    for (const p of activeInAcc) {
        const tracker = activeOrdersTracker.get(p.symbol);
        if (tracker) {
            const mark = parseFloat(p.markPrice);
            if ((tracker.side === 'LONG' && (mark >= tracker.tpPrice || mark <= tracker.slPrice)) || 
                (tracker.side === 'SHORT' && (mark <= tracker.tpPrice || mark >= tracker.slPrice))) {
                await forceCloseMarket(p.symbol, tracker.side, parseFloat(p.positionAmt));
            }
        }
    }

    if (activeInAcc.length < botSettings.maxPositions) {
        for (const coin of status.candidatesList) {
            if (activeOrdersTracker.has(coin.symbol)) continue;
            const info = status.exchangeInfo[coin.symbol];
            if (info) { await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', coin.price, info, coin); break; }
        }
    }
}, 2000);

APP.listen(9001);
