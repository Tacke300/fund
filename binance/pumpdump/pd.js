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

// --- DỮ LIỆU ---
let tradeHistory = { 
    win: 0, loss: 0, pnlWin: 0, pnlLoss: 0, totalPnl: 0, 
    startTime: Date.now(), orders: [] 
};

if (fs.existsSync(HISTORY_FILE)) {
    try { 
        const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        tradeHistory = { ...tradeHistory, ...saved };
    } catch (e) { console.log("Khởi tạo history mới."); }
}

const saveHistory = () => fs.writeFileSync(HISTORY_FILE, JSON.stringify(tradeHistory, null, 2));

let botSettings = { 
    isRunning: false, 
    maxPositions: 5, 
    invValue: 1.5, 
    invType: 'percent', 
    posTP: 1.0, 
    posSL: 3.0, 
    botSLValue: 50.0, 
    botSLType: 'fixed',
    entryDiff: 0.5 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
    
    return new Promise((resolve) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ code: -1, msg: "JSON_ERR" }); } });
        });
        req.on('error', (e) => resolve({ code: -1, msg: e.message }));
        req.end();
    });
}

async function forceCloseMarket(symbol, posSide, amount, reason = "TP/SL") {
    try {
        const res = await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side: posSide === 'LONG' ? 'SELL' : 'BUY', positionSide: posSide, type: 'MARKET', quantity: Math.abs(amount).toString() 
        });
        const data = activeOrdersTracker.get(symbol);
        if (data && (res.orderId || res.avgPrice)) {
            const exitPrice = parseFloat(res.avgPrice || 0);
            const pnl = posSide === 'LONG' ? (exitPrice - data.entryPrice) * amount : (data.entryPrice - exitPrice) * amount;
            
            if (pnl > 0) { tradeHistory.win++; tradeHistory.pnlWin += pnl; } 
            else { tradeHistory.loss++; tradeHistory.pnlLoss += pnl; }
            tradeHistory.totalPnl += pnl;

            tradeHistory.orders.unshift({
                symbol, side: posSide, lev: data.leverage, margin: data.margin,
                entry: data.entryPrice, exit: exitPrice, tp: data.tpPrice, sl: data.slPrice,
                pnl: pnl.toFixed(4), openTime: data.openTime, closeTime: new Date().toLocaleString('vi-VN'),
                snapshot: data.snapshot, reason: reason
            });
            saveHistory();
            addBotLog(`✅ ĐÓNG ${symbol} [${reason}] | PnL: ${pnl.toFixed(2)}$ | Exit: ${exitPrice}`, pnl > 0 ? "success" : "error");
        }
        activeOrdersTracker.delete(symbol);
    } catch (e) { addBotLog(`❌ Lỗi đóng ${symbol}: ${e.message}`, "error"); }
}

async function openPosition(symbol, side, price, info, scan) {
    try {
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const maxLev = brackets[0]?.brackets[0]?.initialLeverage || 20;
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: maxLev });
        
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        let qty = (Math.floor(((margin * maxLev) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        if (parseFloat(qty) * price < 5.1) return;

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const res = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
        
        if (res.orderId) {
            const tp = side === 'BUY' ? price * (1 + botSettings.posTP/100) : price * (1 - botSettings.posTP/100);
            const sl = side === 'BUY' ? price * (1 - botSettings.posSL/100) : price * (1 + botSettings.posSL/100);
            
            activeOrdersTracker.set(symbol, {
                symbol, entryPrice: price, margin: margin.toFixed(2), leverage: maxLev, side: posSide,
                tpPrice: tp.toFixed(info.pricePrecision), slPrice: sl.toFixed(info.pricePrecision),
                openTime: new Date().toLocaleString('vi-VN'), snapshot: { m1: scan.c1, m5: scan.c5, m15: scan.m15 }
            });
            addBotLog(`🚀 MỞ ${symbol} [${posSide}] | M1:${scan.c1}% M5:${scan.c5}% M15:${scan.m15}%`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi mở ${symbol}: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callBinance('/fapi/v2/account');
        if (acc.totalMarginBalance) status.currentBalance = parseFloat(acc.totalMarginBalance);

        // --- LOGIC BOT STOP LOSS (DỪNG TOÀN BOT) ---
        if (botSettings.botSLType === 'fixed' && Math.abs(tradeHistory.totalPnl) >= botSettings.botSLValue && tradeHistory.totalPnl < 0) {
            botSettings.isRunning = false;
            addBotLog(`⚠️ BOT STOPPED: Chạm ngưỡng chặn lỗ tổng (${botSettings.botSLValue}$)`, "error");
            return;
        }

        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activeInAcc = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
        
        for (const p of activeInAcc) {
            const trk = activeOrdersTracker.get(p.symbol);
            if (!trk) continue;
            const mark = parseFloat(p.markPrice);
            trk.markPrice = mark; 
            trk.pnlUsdt = parseFloat(p.unRealizedProfit);

            if ((trk.side === 'LONG' && (mark >= trk.tpPrice || mark <= trk.slPrice)) || 
                (trk.side === 'SHORT' && (mark <= trk.tpPrice || mark >= trk.slPrice))) {
                await forceCloseMarket(p.symbol, trk.side, parseFloat(p.positionAmt), mark >= trk.tpPrice ? "TP" : "SL");
            }
        }

        if (activeInAcc.length < botSettings.maxPositions) {
            for (const coin of status.candidatesList) {
                if (activeOrdersTracker.has(coin.symbol)) continue;
                const diff = botSettings.entryDiff;
                const isLong = (coin.c1 >= diff && coin.c5 >= diff && coin.m15 >= diff);
                const isShort = (coin.c1 <= -diff && coin.c5 <= -diff && coin.m15 <= -diff);
                
                if (isLong || isShort) {
                    const info = status.exchangeInfo[coin.symbol];
                    if (info) { 
                        await openPosition(coin.symbol, isLong ? 'BUY' : 'SELL', coin.price, info, coin); 
                        break; 
                    }
                }
            }
        }
    } catch (e) {}
}

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 2000);

setInterval(mainLoop, 2500);

const infoEx = await callBinance('/fapi/v1/exchangeInfo');
if (infoEx.symbols) {
    infoEx.symbols.forEach(s => {
        const f = s.filters.find(f => f.filterType === 'LOT_SIZE');
        status.exchangeInfo[s.symbol] = { stepSize: parseFloat(f.stepSize), quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision };
    });
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), tradeHistory, status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
