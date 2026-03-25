import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let botSettings = { isRunning: false, maxPositions: 3, invValue: 1.5, invType: 'percent', minVol: 5.0, accountSL: 30, posTP: 1.0, posSL: 3.0 };
let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
}

async function syncServerTime() {
    return new Promise((resolve) => {
        https.get('https://fapi.binance.com/fapi/v1/time', res => {
            let d = ''; res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try { serverTimeOffset = JSON.parse(d).serverTime - Date.now(); resolve(); } catch (e) { resolve(); }
            });
        }).on('error', () => resolve());
    });
}

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

async function forceCloseMarket(symbol, posSide, amount) {
    try {
        const side = posSide === 'LONG' ? 'SELL' : 'BUY';
        // BỎ reduceOnly để tránh lỗi sàn từ chối
        await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: Math.abs(amount).toString()
        });
        await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        activeOrdersTracker.delete(symbol);
        addBotLog(`✅ ĐÓNG ${symbol} (${posSide})`, "success");
    } catch (e) {
        addBotLog(`❌ Lỗi đóng ${symbol}: ${e.msg}`, "error");
    }
}

async function openPosition(symbol, side, price, info, volInfo) {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        let marginUSDT = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const leverage = brackets[0]?.brackets[0]?.initialLeverage || 20;
        
        let rawQty = (marginUSDT * leverage) / price;
        let qty = (Math.floor(rawQty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        // KIỂM TRA ĐIỀU KIỆN 5 USDT (Notional)
        if (parseFloat(qty) * price < 5.1) {
            return; // Im lặng bỏ qua để tránh spam log "insufficient"
        }

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty
        });

        if (order.orderId) {
            const tpRate = botSettings.posTP / 100;
            const slRate = botSettings.posSL / 100;
            const tpPrice = parseFloat((side === 'BUY' ? price * (1 + tpRate) : price * (1 - tpRate)).toFixed(info.pricePrecision));
            const slPrice = parseFloat((side === 'BUY' ? price * (1 - slRate) : price * (1 + slRate)).toFixed(info.pricePrecision));

            try {
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true', workingType: 'LAST_PRICE' });
                await callBinance('/fapi/v1/order', 'POST', { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true', workingType: 'LAST_PRICE' });
            } catch (err) {}
            
            activeOrdersTracker.set(symbol, { entryPrice: price, side: posSide, tpPrice, slPrice, openTime: Date.now() });
            
            // LOG CHI TIẾT NHƯ YÊU CẦU
            addBotLog(`🚀 MỞ: ${symbol} | ${posSide} ${leverage}x | Entry: ${price} | TP: ${tpPrice} | SL: ${slPrice} | Margin: ${marginUSDT.toFixed(1)}$ | Vol: ${volInfo}`, "success");
        }
    } catch (e) { 
        if (!e.msg.includes("insufficient")) addBotLog(`❌ Lỗi ${symbol}: ${e.msg}`, "error"); 
    }
}

async function trackClosedPositions() {
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        for (const [symbol, data] of activeOrdersTracker) {
            const currentPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side);
            const amt = parseFloat(currentPos?.positionAmt || 0);
            const markPrice = parseFloat(currentPos?.markPrice || 0);

            if (amt === 0) { activeOrdersTracker.delete(symbol); continue; }
            
            const isLong = data.side === 'LONG';
            const hitTP = isLong ? markPrice >= data.tpPrice : markPrice <= data.tpPrice;
            const hitSL = isLong ? markPrice <= data.slPrice : markPrice >= data.slPrice;
            
            if (hitTP || hitSL || (Date.now() - data.openTime > 5 * 60 * 1000)) {
                await forceCloseMarket(symbol, data.side, amt);
            }
        }
    } catch (e) {}
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        await syncServerTime(); 
        await trackClosedPositions(); 
        const positions = await callBinance('/fapi/v2/positionRisk');
        const activeCount = positions.filter(p => parseFloat(p.positionAmt) !== 0).length;
        if (activeCount >= botSettings.maxPositions) return;

        for (const coin of status.candidatesList) {
            if (activeOrdersTracker.has(coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            const info = status.exchangeInfo[coin.symbol];
            if (!info) continue;
            
            pendingSymbols.add(coin.symbol);
            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: coin.symbol });
            const volStr = `1m:${coin.c1}% 5m:${coin.c5}%`;
            await openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', parseFloat(ticker.price), info, volStr);
            pendingSymbols.delete(coin.symbol);
            break; 
        }
    } catch (e) {}
}

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
            entryPrice: parseFloat(p.entryPrice),
            markPrice: parseFloat(p.markPrice),
            pnlPercent: ((parseFloat(p.unRealizedProfit) / (parseFloat(p.isolatedWallet) || 1)) * 100).toFixed(2)
        }));
        res.json({ botSettings, activePositions: active, topVolatility: status.candidatesList.slice(0, 5), status });
    } catch (e) { res.json({ botSettings, activePositions: [], topVolatility: [], status }); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

async function init() {
    await syncServerTime();
    try {
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const prc = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), tickSize: parseFloat(prc.tickSize) };
        });
    } catch (e) {}
}

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => {
            try {
                const response = JSON.parse(d);
                const rawData = response.live || response.top5 || [];
                status.candidatesList = rawData.map(c => ({
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 1000);

init(); setInterval(mainLoop, 2000); // Tăng lên 2s để giảm spam API
APP.listen(9001, '0.0.0.0');
