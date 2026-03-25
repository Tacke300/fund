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
    minVol: 2.0, posTP: 1.0, posSL: 3.0 
};

let status = { currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [] };
let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const color = type === 'success' ? '\x1b[32m' : (type === 'error' ? '\x1b[31m' : '\x1b[36m');
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

async function callBinance(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now() + serverTimeOffset;
    const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { 
                try { resolve(JSON.parse(d)); } catch (e) { reject(e); } 
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function openPosition(symbol, side, price, info, scan) {
    try {
        const acc = await callBinance('/fapi/v2/account');
        if (!acc.totalMarginBalance) throw { msg: "Không lấy được số dư" };
        status.currentBalance = parseFloat(acc.totalMarginBalance);
        
        // Luôn lấy đòn bẩy cao nhất có thể hoặc mặc định 20
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const lev = brackets[0]?.brackets[0]?.initialLeverage || 20;
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });

        let margin = botSettings.invType === 'percent' ? (status.currentBalance * botSettings.invValue) / 100 : botSettings.invValue;
        
        // FIX LỖI NOTIONAL < 5: Tự động tính toán Qty tối thiểu 5.5 USDT để an toàn
        let minQty = (5.5 / price);
        let userQty = (margin * lev) / price;
        let finalQty = Math.max(userQty, minQty);
        
        let qtyStr = (Math.floor(finalQty / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        addBotLog(`[LỆNH] Thử mở ${symbol} | Qty: ${qtyStr} | Vốn thực: ${(parseFloat(qtyStr)*price/lev).toFixed(2)}$`, "info");

        const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
        const order = await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: qtyStr 
        });

        if (order.orderId) {
            const tp = (side === 'BUY' ? price * (1 + botSettings.posTP/100) : price * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (side === 'BUY' ? price * (1 - botSettings.posSL/100) : price * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            // Dùng STOP_MARKET và TAKE_PROFIT_MARKET bản chuẩn
            await callBinance('/fapi/v1/order', 'POST', { 
                symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, 
                type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE', timeInForce: 'GTC'
            });
            await callBinance('/fapi/v1/order', 'POST', { 
                symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, 
                type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE', timeInForce: 'GTC'
            });
            
            activeOrdersTracker.set(symbol, { symbol, entryPrice: price, margin: (parseFloat(qtyStr)*price/lev).toFixed(2), side: posSide, tpPrice: tp, slPrice: sl, snapshot: scan });
            addBotLog(`✅ THÀNH CÔNG: ${symbol} | Entry: ${price} | Lev: ${lev}x`, "success");
        } else {
            addBotLog(`❌ Thất bại ${symbol}: ${order.msg}`, "error");
        }
    } catch (e) { addBotLog(`❌ Lỗi hệ thống ${symbol}: ${e.msg || e.message}`, "error"); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const resTime = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
        serverTimeOffset = resTime.serverTime - Date.now();

        const posRisk = await callBinance('/fapi/v2/positionRisk');
        if (!Array.isArray(posRisk)) return;

        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
        
        // Log soi kèo chi tiết ra PM2
        if (status.candidatesList.length > 0) {
            const top = status.candidatesList[0];
            console.log(`[SOI] ${top.symbol} | 1m:${top.c1}% 5m:${top.c5}% 15m:${top.c15}% | maxV:${top.maxV}% | Mục tiêu: ${botSettings.minVol}%`);
        }

        if (activePositions.length >= botSettings.maxPositions) return;

        for (const coin of status.candidatesList) {
            if (activePositions.some(p => p.symbol === coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            
            if (coin.maxV >= botSettings.minVol) {
                const info = status.exchangeInfo[coin.symbol];
                if (!info) continue;

                pendingSymbols.add(coin.symbol);
                const side = coin.c1 >= 0 ? 'BUY' : 'SELL';
                const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol: coin.symbol });
                
                addBotLog(`🎯 VÀO LỆNH: ${coin.symbol} | Biến động: ${coin.maxV}%`, "info");
                await openPosition(coin.symbol, side, parseFloat(ticker.price), info, coin);
                
                setTimeout(() => pendingSymbols.delete(coin.symbol), 15000); 
                break; 
            }
        }
    } catch (e) { console.log("Loop Error:", e.message); }
}

// Lấy data từ Scanner Port 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
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

async function init() {
    const info = await callBinance('/fapi/v1/exchangeInfo');
    if (info.symbols) {
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize) };
        });
        addBotLog("⚓ Hạm đội Luffy v7.0 - Gear 5 sẵn sàng!", "success");
    }
}

init(); setInterval(mainLoop, 3000);
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
