import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let tpPercent = 5.0; 
let slPercent = 5.0; 

let botSettings = { isRunning: false, maxPositions: 10, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let botManagedSymbols = []; 
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;
let isSettingTPSL = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 2000; 
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

async function enforceBaoVe(symbol, side, type, price, qty, info) {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        addBotLog(`[${symbol}] Thử cài ${type} lần ${attempt}/3 (Giá: ${price})...`, "info");
        
        // Cách 1: Algo Market
        let res = await tryOrder({
            symbol, side: closeSide, positionSide: side,
            type: type === 'TP' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
            stopPrice: price, workingType: 'MARK_PRICE', closePosition: 'true'
        });
        
        // Cách 2: Nếu Market lỗi, thử Algo Limit
        if (res.error) {
            res = await tryOrder({
                symbol, side: closeSide, positionSide: side,
                type: type === 'TP' ? 'LIMIT' : 'STOP',
                price: price, stopPrice: price, quantity: qty, timeInForce: 'GTC', workingType: 'MARK_PRICE'
            });
        }

        if (!res.error) {
            addBotLog(`✅ [${symbol}] Cài ${type} THÀNH CÔNG tại giá ${price}`, "success");
            return true;
        }

        addBotLog(`❌ [${symbol}] Cài ${type} THẤT BẠI: ${res.error}. Thử lại sau 15s...`, "error");
        if (attempt < 3) await new Promise(r => setTimeout(r, 15000));
    }
    return false;
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing || isSettingTPSL) return;
    
    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        for (const c of status.candidatesList.filter(c => c.maxV >= botSettings.minVol)) {
            if (activeOnExchange.includes(c.symbol) || botManagedSymbols.includes(c.symbol)) continue;
            if (blockedSymbols.has(c.symbol) && Date.now() < blockedSymbols.get(c.symbol)) continue;

            const info = status.exchangeInfo[c.symbol];
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
            const currentPrice = parseFloat(ticker.price);
            
            let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
            const lev = 50; 
            let qty = (Math.floor(((margin * lev) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(()=>{});

            const side = c.changePercent > 0 ? 'BUY' : 'SELL';
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

            addBotLog(`🎯 Đang mở vị thế: ${c.symbol} (${posSide}) | Giá: ${currentPrice} | Vol: ${qty}`, "info");
            const order = await tryOrder({ symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

            if (order.orderId) {
                botManagedSymbols.push(c.symbol);
                isSettingTPSL = true;
                addBotLog(`🔥 Khớp lệnh ${c.symbol}. Đang chiếm slot ${botManagedSymbols.length}/${botSettings.maxPositions}. Chờ 5s để xác nhận sàn...`, "success");

                setTimeout(async () => {
                    const postionsCheck = await callBinance('/fapi/v2/positionRisk');
                    const p = postionsCheck.find(pos => pos.symbol === c.symbol && parseFloat(pos.positionAmt) !== 0);
                    
                    if (p) {
                        const entry = parseFloat(p.entryPrice);
                        const pQty = Math.abs(parseFloat(p.positionAmt));
                        const tpP = (Math.round((posSide === 'LONG' ? entry * (1 + tpPercent / 100) : entry * (1 - tpPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
                        const slP = (Math.round((posSide === 'LONG' ? entry * (1 - slPercent / 100) : entry * (1 + slPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);

                        const tpRes = await enforceBaoVe(c.symbol, posSide, 'TP', tpP, pQty, info);
                        await new Promise(r => setTimeout(r, 2000));
                        const slRes = await enforceBaoVe(c.symbol, posSide, 'SL', slP, pQty, info);

                        if (!tpRes || !slRes) {
                            addBotLog(`⚠️ CẢNH BÁO: ${c.symbol} cài bảo vệ không đủ bộ! Kiểm tra tay gấp.`, "error");
                        }
                    } else {
                        addBotLog(`❓ Lỗi: Không tìm thấy vị thế ${c.symbol} trên sàn để cài TP/SL.`, "warn");
                    }
                    isSettingTPSL = false;
                }, 5000);
                break;
            } else {
                addBotLog(`❌ Lỗi mở ${c.symbol}: ${order.error}`, "error");
            }
        }
    } finally { isProcessing = false; }
}

async function cleanup() {
    if (isSettingTPSL) return;
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            if (!activeOnExchange.includes(s)) {
                addBotLog(`🏁 [${s}] Vị thế đã đóng. Đang dọn dẹp lệnh chờ...`, "warn");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
                blockedSymbols.set(s, Date.now() + 10 * 60 * 1000);
            }
        }
    } catch (e) {}
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

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        res.json({ botSettings, botRunningSlots: botManagedSymbols, status });
    } catch (e) { res.status(500).send("ERR"); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ status: "ok" }); });

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
            isInitializing = false;
            addBotLog("🚀 HỆ THỐNG ĐÃ SẴN SÀNG", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 2000);
setInterval(hunt, 4000);
setInterval(cleanup, 8000);
APP.listen(9001, '0.0.0.0');
