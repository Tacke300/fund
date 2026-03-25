import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', 
    minVol: 0.5, posTP: 1.0, posSL: 3.0 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    // LOG RA CONSOLE ĐỂ XEM TRONG PM2
    const color = type === 'success' ? '\x1b[32m' : (type === 'error' ? '\x1b[31m' : '\x1b[36m');
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

async function syncServerTime() {
    try {
        const res = await new Promise((resolve, reject) => {
            https.get('https://fapi.binance.com/fapi/v1/time', r => {
                let d = ''; r.on('data', c => d += c);
                r.on('end', () => resolve(JSON.parse(d)));
            }).on('error', reject);
        });
        serverTimeOffset = res.serverTime - Date.now();
    } catch (e) { console.log("Lỗi sync time:", e.message); }
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    await syncServerTime();
    const timestamp = Date.now() + serverTimeOffset;
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { 
                    const j = JSON.parse(d);
                    if (res.statusCode >= 400) reject(j);
                    else resolve(j); 
                } catch (e) { reject(e); } 
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function openPosition(symbol, side, price, info, scan) {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const leverage = brackets[0]?.brackets[0]?.initialLeverage || 20;
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage });

        let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        let qty = (Math.floor(((margin * leverage) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        if (parseFloat(qty) * price < 5.0) return addBotLog(`⚠️ Vốn lệnh ${symbol} quá thấp (<5$), bỏ qua.`, "warn");

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

        if (order.orderId) {
            const tp = (side === 'BUY' ? price * (1 + botSettings.posTP/100) : price * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (side === 'BUY' ? price * (1 - botSettings.posSL/100) : price * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            // Cài TP/SL lên sàn ngay lập tức
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE' });
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' });
            
            activeOrdersTracker.set(symbol, { symbol, entryPrice: price, margin: margin.toFixed(2), side: posSide, tpPrice: tp, slPrice: sl, snapshot: scan });
            addBotLog(`🚀 Đã mở ${symbol} [${posSide}] - Entry: ${price} - TP: ${tp} - SL: ${sl}`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi đặt lệnh ${symbol}: ${e.msg || e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        // CHỐNG LỖI .filter is not a function
        if (!Array.isArray(posRisk)) {
            console.log("⚠️ Binance trả về lỗi:", posRisk);
            return;
        }

        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
        
        // Cập nhật giá Mark & PnL cho UI
        for (const [sym, data] of activeOrdersTracker) {
            const p = activePositions.find(pos => pos.symbol === sym);
            if (!p) activeOrdersTracker.delete(sym);
            else {
                data.markPrice = parseFloat(p.markPrice).toFixed(status.exchangeInfo[sym]?.pricePrecision || 4);
                data.pnlUsdt = parseFloat(p.unRealizedProfit).toFixed(2);
            }
        }

        if (activePositions.length >= botSettings.maxPositions) return;

        // LOG TRẠNG THÁI QUÉT COIN
        if (status.candidatesList.length > 0) {
            const best = status.candidatesList[0];
            console.log(`[SCAN] Đang soi: ${best.symbol} | 1m: ${best.c1}% | 5m: ${best.c5}% | 15m: ${best.c15}% | maxV: ${best.maxV}% (Target: ${botSettings.minVol}%)`);
        }

        for (const coin of status.candidatesList) {
            if (activePositions.some(p => p.symbol === coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            
            // LOGIC VÀO LỆNH
            if (coin.maxV >= botSettings.minVol) {
                const info = status.exchangeInfo[coin.symbol];
                if (!info) continue;

                pendingSymbols.add(coin.symbol);
                addBotLog(`🎯 Kèo thơm: ${coin.symbol} (Biến động: ${coin.maxV}%)`, "info");
                
                const side = coin.c1 >= 0 ? 'BUY' : 'SELL';
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: coin.symbol });
                await openPosition(coin.symbol, side, parseFloat(ticker.price), info, coin);
                
                pendingSymbols.add(coin.symbol);
                setTimeout(() => pendingSymbols.delete(coin.symbol), 10000); // Chống spam lệnh 10s
                break; 
            }
        }
    } catch (e) { console.log("Lỗi MainLoop:", e.message); }
}

// FETCH DATA TỪ SCANNER PORT 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                status.candidatesList = (response.live || []).map(c => ({
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15 || c.m15 || 0,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15 || c.m15 || 0))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

const init = async () => {
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize) 
            };
        });
        addBotLog("✅ Hạm đội Luffy v6.8 khởi tạo thành công!", "success");
    } catch (e) { console.log("Lỗi Init:", e); }
}

init();
setInterval(mainLoop, 3000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
