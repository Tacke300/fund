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

let botSettings = { 
    isRunning: false, 
    maxPositions: 10, 
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

let botManagedSymbols = []; 
let blockedSymbols = new Map(); 
let isInitializing = true;
let isProcessing = false;
let marginErrorTime = 0;
let lastOrderTime = 0;
let isSettingTPSL = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    const colors = { success: '\x1b[32m', error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
    console.log(`${colors[type] || ''}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() - 2500; 
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=20000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(j); 
                    else reject({ ...j, statusCode: res.statusCode });
                } catch (e) { reject({ msg: "API_REJECT", detail: d }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

function fetchCandidates() {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                const all = response.live || [];
                status.candidatesList = all.map(c => ({
                    symbol: c.symbol, 
                    changePercent: c.c1, 
                    triggerFrame: "1M",
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15)),
                    c1: c.c1, c5: c.c5, c15: c.c15
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}

async function hunt() {
    if (isInitializing || !botSettings.isRunning || isProcessing || isSettingTPSL) return;
    if (marginErrorTime > 0 && Date.now() < marginErrorTime) return;
    if (Date.now() - lastOrderTime < 15000) return;

    try {
        isProcessing = true;
        if (botManagedSymbols.length >= botSettings.maxPositions) return;

        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        const now = Date.now();
        const targets = status.candidatesList.filter(c => c.maxV >= botSettings.minVol);

        for (const c of targets) {
            if (activeOnExchange.includes(c.symbol)) continue; 
            if (botManagedSymbols.includes(c.symbol)) continue;
            if (blockedSymbols.has(c.symbol) && now < blockedSymbols.get(c.symbol)) continue;

            try {
                const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol: c.symbol });
                const lev = brackets[0].brackets[0].initialLeverage;
                if (lev <= 20) continue; 

                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: c.symbol });
                const currentPrice = parseFloat(ticker.price);
                const info = status.exchangeInfo[c.symbol];
                
                let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
                if ((margin * lev) < 5.5) continue; 

                const side = c.changePercent > 0 ? 'BUY' : 'SELL';
                const posSide = c.changePercent > 0 ? 'LONG' : 'SHORT';
                let qty = Math.floor(((margin * lev) / currentPrice) / info.stepSize) * info.stepSize;
                const finalQty = qty.toFixed(info.quantityPrecision);

                addBotLog(`🚀 MỞ VỊ THẾ: ${c.symbol} | Khung: ${c.triggerFrame} | Biến động: ${c.maxV}% | Giá vào: ${currentPrice} | Đòn bẩy: x${lev} | Slot: ${botManagedSymbols.length + 1}/${botSettings.maxPositions}`, "info");

                await callBinance('/fapi/v1/leverage', 'POST', { symbol: c.symbol, leverage: lev });
                
                const order = await callBinance('/fapi/v1/order', 'POST', {
                    symbol: c.symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty
                });

                if (order.orderId) {
                    addBotLog(`✅ Khớp lệnh ${c.symbol}. Đợi cài TP/SL...`, "success");
                    botManagedSymbols.push(c.symbol);
                    isSettingTPSL = true; 
                    
                    // Cài TP sau 5s, sau đó SL sau 6.5s (cách nhau 1.5s)
                    setTimeout(() => enforceTP(c.symbol), 5000);
                    setTimeout(() => {
                        enforceSL(c.symbol);
                        lastOrderTime = Date.now();
                        isSettingTPSL = false;
                    }, 6500);
                    
                    break; 
                }
            } catch (err) {
                addBotLog(`❌ Lỗi thực thi ${c.symbol}: ${err.msg || "N/A"}`, "error");
            }
        }
    } finally { isProcessing = false; }
}

async function enforceTP(symbol) {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
        if (!p) return;

        const info = status.exchangeInfo[symbol];
        const side = p.positionSide;
        const entry = parseFloat(p.entryPrice);
        const tpPrice = (Math.round((side === 'LONG' ? entry * (1 + tpPercent / 100) : entry * (1 - tpPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side: closeSide, positionSide: side, 
            type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, 
            workingType: 'MARK_PRICE', closePosition: 'true' 
        });
        addBotLog(`🛡️ Đã cài TP cho ${symbol}: ${tpPrice}`, "success");
    } catch (e) { addBotLog(`⚠️ Lỗi cài TP ${symbol}: ${e.msg}`, "error"); }
}

async function enforceSL(symbol) {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const p = positions.find(pos => pos.symbol === symbol && parseFloat(pos.positionAmt) !== 0);
        if (!p) return;

        const info = status.exchangeInfo[symbol];
        const side = p.positionSide;
        const entry = parseFloat(p.entryPrice);
        const slPrice = (Math.round((side === 'LONG' ? entry * (1 - slPercent / 100) : entry * (1 + slPercent / 100)) / info.tickSize) * info.tickSize).toFixed(info.pricePrecision);
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';

        await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side: closeSide, positionSide: side, 
            type: 'STOP_MARKET', stopPrice: slPrice, 
            workingType: 'MARK_PRICE', closePosition: 'true' 
        });
        addBotLog(`🛡️ Đã cài SL cho ${symbol}: ${slPrice}`, "success");
    } catch (e) { addBotLog(`⚠️ Lỗi cài SL ${symbol}: ${e.msg}`, "error"); }
}

async function cleanupClosedPositions() {
    try {
        const positions = await callBinance('/fapi/v2/positionRisk');
        const now = Date.now();
        const activeSymbolsOnExchange = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => p.symbol);

        for (let i = botManagedSymbols.length - 1; i >= 0; i--) {
            const s = botManagedSymbols[i];
            if (!activeSymbolsOnExchange.includes(s)) {
                botManagedSymbols.splice(i, 1);
                addBotLog(`🏁 TRỐNG SLOT: ${s} đã đóng. Bot hiện còn dư ${botSettings.maxPositions - botManagedSymbols.length} slot.`, "warn");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol: s }).catch(()=>{});
                blockedSymbols.set(s, now + 15 * 60 * 1000);
            }
        }
    } catch (e) {}
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

APP.post('/api/settings', (req, res) => {
    if (req.body.maxPositions) botSettings.maxPositions = parseInt(req.body.maxPositions);
    botSettings = { ...botSettings, ...req.body };
    addBotLog(`⚙️ Hệ thống cập nhật: Tối đa ${botSettings.maxPositions} lệnh bot.`, "warn");
    res.json({ status: "ok" });
});

async function init() {
    https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => {
            const info = JSON.parse(d);
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
            isInitializing = false;
            addBotLog("🚀 HỆ THỐNG ĐÃ SẴN SÀNG.", "success");
        });
    });
}

init();
setInterval(fetchCandidates, 2000);
setInterval(hunt, 3000);
setInterval(cleanupClosedPositions, 5000);
APP.listen(9001, '0.0.0.0');
