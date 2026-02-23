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
    console.log(`[${time}] ${msg}`);
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
    try { return await callBinance('/fapi/v1/order', 'POST', params); } catch (e) { return { error: e.msg || e.code }; }
}

async function enforceBaoVe(symbol, side, type, price, qty, info) {
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const posSide = side;
    
    // Cách 1: Thử STOP_MARKET / TAKE_PROFIT_MARKET (Chuẩn Market)
    let res = await tryOrder({
        symbol, side: closeSide, positionSide: posSide,
        type: type === 'TP' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
        stopPrice: price, workingType: 'MARK_PRICE', closePosition: 'true'
    });
    if (!res.error) return true;

    // Cách 2: Thử LIMIT / STOP (Chuẩn Algo)
    res = await tryOrder({
        symbol, side: closeSide, positionSide: posSide,
        type: type === 'TP' ? 'LIMIT' : 'STOP',
        price: price, stopPrice: price, quantity: qty, timeInForce: 'GTC', workingType: 'MARK_PRICE'
    });
    if (!res.error) return true;

    // Cách 3: Lệnh LIMIT thuần (Cho TP)
    if (type === 'TP') {
        res = await tryOrder({
            symbol, side: closeSide, positionSide: posSide,
            type: 'LIMIT', price: price, quantity: qty, timeInForce: 'GTC'
        });
        if (!res.error) return true;
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
            const lev = 50; // Mặc định x50 để tính toán
            let qty = (Math.floor(((margin * lev) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

            // DỌN LỆNH CHỜ TRƯỚC KHI MỞ
            await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: c.symbol }).catch(()=>{});

            const side = c.changePercent > 0 ? 'BUY' : 'SELL';
            const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';

            const order = await tryOrder({ symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });

            if (order.orderId) {
                addBotLog(`🚀 MỞ: ${c.symbol} | Giá: ${currentPrice} | Slot: ${botManagedSymbols.length + 1}`, "success");
                botManagedSymbols.push(c.symbol);
                isSettingTPSL = true;

                setTimeout(async () => {
                    const postionsCheck = await callBinance('/fapi/v2/positionRisk');
                    const p = postionsCheck.find(pos => pos.symbol === c.symbol && parseFloat(pos.positionAmt) !== 0);
                    if (p) {
                        const entry = parseFloat(p.entryPrice);
                        const pQty = Math.abs(parseFloat(p.positionAmt));
                        const tpP = (Math.round((posSide === 'LONG' ? entry * (1 + tpPercent / 100) : entry * (1 - tpPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
                        const slP = (Math.round((posSide === 'LONG' ? entry * (1 - slPercent / 100) : entry * (1 + slPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);

                        const tpOk = await enforceBaoVe(c.symbol, posSide, 'TP', tpP, pQty, info);
                        await new Promise(r => setTimeout(r, 1000));
                        const slOk = await enforceBaoVe(c.symbol, posSide, 'SL', slP, pQty, info);
                        
                        addBotLog(`🛡️ ${c.symbol}: TP ${tpOk ? 'OK' : 'FAIL'} | SL ${slOk ? 'OK' : 'FAIL'}`, tpOk && slOk ? "success" : "error");
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
                // ĐÃ ĐÓNG THÌ DỌN LỆNH CHỜ
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                botManagedSymbols.splice(i, 1);
                blockedSymbols.set(s, Date.now() + 5 * 60 * 1000);
                addBotLog(`🏁 ĐÃ CHỐT: ${s}. Slot trống: ${botSettings.maxPositions - botManagedSymbols.length}`, "warn");
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
            addBotLog("🚀 BOT READY");
        });
    });
}

init();
setInterval(fetchCandidates, 2000);
setInterval(hunt, 4000);
setInterval(cleanup, 8000);
APP.listen(9001, '0.0.0.0');
