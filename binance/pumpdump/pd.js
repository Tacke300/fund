import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP = express();

// ============================================================================
// ⚙️ CONFIG & STATUS
// ============================================================================
let botSettings = { isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', minVol: 6.5, posTP: 0.5, posSL: 5.0, dcaStep: 10, maxDCA: 8 };
let status = { initialBalance: 0, currentBalance: 0, botLogs: [], exchangeInfo: {}, candidatesList: [], totalPnlToday: 0 };
let activeOrdersTracker = new Map(); 
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;
            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, timeout: 5000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('error', reject); req.end();
            });
            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now(); continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// 🎯 HÀM ĐÓNG VỊ THẾ FAILSAFE (BOT LỚP 3)
async function forceClosePosition(symbol, posSide, reason = "Unknown") {
    try {
        const risk = await callBinance('/fapi/v2/positionRisk');
        const p = risk.find(x => x.symbol === symbol && x.positionSide === posSide);
        const qty = Math.abs(parseFloat(p?.positionAmt || 0));

        if (qty > 0) {
            const side = posSide === 'LONG' ? 'SELL' : 'BUY';
            const res = await callBinance('/fapi/v1/order', 'POST', {
                symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty, reduceOnly: 'true'
            });

            if (res.orderId) {
                addBotLog(`🛡️ BOT LỚP 3: Đóng ${symbol} (${reason}) thành công. Qty: ${qty}`, "warning");
                return true;
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi đóng Bot Lớp 3 ${symbol}: ${e.message}`, "error"); }
    return false;
}

// 🚀 MỞ VỊ THẾ & CÀI ĐẶT 3 LỚP GIÁP
async function openPosition(symbol, side, info, isReverse = false) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    try {
        const acc = await callBinance('/fapi/v2/account');
        const priceRes = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const price = parseFloat(priceRes.price);
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isReverse) margin *= 10;

        let qty = (Math.floor(((margin * 20) / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: 20 });
        
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: qty });
        
        if (order.orderId) {
            await sleep(1500);
            const pos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === posSide);
            const entry = parseFloat(pos.entryPrice);
            const qtyOnFloor = Math.abs(parseFloat(pos.positionAmt));
            
            let tp = (posSide === 'LONG' ? entry * (1 + (isReverse ? 50 : botSettings.posTP)/100) : entry * (1 - (isReverse ? 50 : botSettings.posTP)/100)).toFixed(info.pricePrecision);
            let sl = (posSide === 'LONG' ? entry * (1 - (isReverse ? 50 : botSettings.posSL)/100) : entry * (1 + (isReverse ? 50 : botSettings.posSL)/100)).toFixed(info.pricePrecision);

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entry, initialEntry: entry, 
                qty: qtyOnFloor, tp, sl, dcaCount: 0, isClosing: false, orderIds: [order.orderId] 
            });

            // LỚP 1: ALGO (TAKE_PROFIT/STOP LIMIT - Thường khớp tốt hơn)
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT', stopPrice: tp, price: tp, quantity: qtyOnFloor, reduceOnly: 'true', workingType: 'MARK_PRICE' });
            // LỚP 2: FAP (STOP_MARKET/TP_MARKET - Giáp sàn cuối)
            await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' });
            
            addBotLog(`✅ OPEN ${symbol} @${entry} | TP: ${tp} | SL: ${sl}`, "success");
            await updateAccountStatus(); // Cập nhật số dư ngay sau khi mở
        }
    } catch (e) { addBotLog(`❌ Lỗi mở lệnh ${symbol}: ${e.message}`, "error"); }
}

async function updateAccountStatus() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalWalletBalance);
        if (status.initialBalance === 0) status.initialBalance = status.currentBalance;
        status.totalPnlToday = status.currentBalance - status.initialBalance;
    } catch (e) { console.error("Lỗi cập nhật số dư:", e.message); }
}

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        await updateAccountStatus();
        const posRisk = await callBinance('/fapi/v2/positionRisk');

        for (let [symbol, data] of activeOrdersTracker) {
            if (data.isClosing) continue;

            const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const price = parseFloat(ticker.price);
            const floorPos = posRisk.find(p => p.symbol === symbol && p.positionSide === data.side && Math.abs(parseFloat(p.positionAmt)) > 0);

            // KIỂM TRA ĐÓNG THỰC TẾ (Sàn đã khớp TP/SL)
            if (!floorPos) {
                data.isClosing = true;
                await sleep(2000); 
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
                const relevantTrades = trades.filter(t => t.positionSide === data.side);
                const totalPnl = relevantTrades.reduce((s, t) => s + parseFloat(t.realizedPnl), 0);
                
                addBotLog(`💰 ĐÃ CHỐT ${symbol}. PnL: ${totalPnl.toFixed(2)}$`, totalPnl >= 0 ? "success" : "error");
                activeOrdersTracker.delete(symbol);
                // Dọn lệnh thừa
                callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
                continue;
            }

            // LỚP 3: BOT THEO DÕI (FAILSAFE)
            let isHitTP = (data.side === 'LONG' && price >= data.tp) || (data.side === 'SHORT' && price <= data.tp);
            let isHitSL = (data.side === 'LONG' && price <= data.sl) || (data.side === 'SHORT' && price >= data.sl);

            if (isHitTP || isHitSL) {
                data.isClosing = true;
                await forceClosePosition(symbol, data.side, isHitTP ? "BOT TP" : "BOT SL");
                continue;
            }

            // DCA LOGIC
            const diff = ((price - data.entry) / data.entry) * 100;
            const isAgainst = (data.side === 'LONG' && diff <= -botSettings.dcaStep) || (data.side === 'SHORT' && diff >= botSettings.dcaStep);

            if (isAgainst && !data.isClosing && data.dcaCount < botSettings.maxDCA) {
                data.dcaCount++;
                const info = status.exchangeInfo[symbol];
                const dcaQty = (data.qty).toFixed(info.quantityPrecision); // DCA gấp đôi hoặc bằng qty cũ tùy chiến thuật, ở đây giữ nguyên qty cũ
                
                addBotLog(`📉 DCA Lần ${data.dcaCount}: ${symbol} @${price}`, "warning");
                const dcaOrder = await callBinance('/fapi/v1/order', 'POST', { symbol, side: data.side === 'LONG' ? 'BUY' : 'SELL', positionSide: data.side, type: 'MARKET', quantity: dcaQty });
                
                if (dcaOrder.orderId) {
                    await sleep(2000);
                    const newPos = (await callBinance('/fapi/v2/positionRisk')).find(p => p.symbol === symbol && p.positionSide === data.side);
                    data.entry = parseFloat(newPos.entryPrice);
                    data.qty = Math.abs(parseFloat(newPos.positionAmt));
                    data.tp = (data.side === 'LONG' ? data.entry * (1 + botSettings.posTP/100) : data.entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
                    data.sl = (data.side === 'LONG' ? data.entry * (1 - botSettings.posSL/100) : data.entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);
                    
                    // Cập nhật lại các lớp giáp trên sàn
                    await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                    const closeSide = data.side === 'LONG' ? 'SELL' : 'BUY';
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: data.side, type: 'TAKE_PROFIT', stopPrice: data.tp, price: data.tp, quantity: data.qty, reduceOnly: 'true', workingType: 'MARK_PRICE' });
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: data.side, type: 'STOP_MARKET', stopPrice: data.sl, closePosition: 'true', workingType: 'MARK_PRICE' });
                }
            } else if (isAgainst && data.dcaCount >= botSettings.maxDCA) {
                addBotLog(`💀 Max DCA - REVERSE ${symbol}`, "error");
                data.isClosing = true;
                await forceClosePosition(symbol, data.side, "MAX DCA REVERSE");
                await sleep(2000);
                await openPosition(symbol, data.side === 'LONG' ? 'SELL' : 'BUY', status.exchangeInfo[symbol], true);
            }
        }
    } catch (e) { console.error("Main Loop Error:", e.message); }
}

async function init() {
    addBotLog("🤖 Hệ thống đang khởi động...", "info");
    try {
        const exchangeRes = await callBinance('/fapi/v1/exchangeInfo');
        exchangeRes.symbols.forEach(s => {
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                stepSize: parseFloat(lotFilter.stepSize),
                tickSize: parseFloat(priceFilter.tickSize)
            };
        });
        await updateAccountStatus();
        addBotLog(`💰 Số dư ban đầu: ${status.initialBalance} USDT`, "info");
        botSettings.isRunning = true;
    } catch (e) { addBotLog("❌ Lỗi khởi tạo: " + e.message, "error"); }
}

// Khởi chạy
init();
setInterval(mainLoop, 4000); // Tăng lên 4s để tránh rate limit và spam log

APP.get('/status', (req, res) => res.json(status));
APP.listen(9001, () => console.log("Server API running on port 9001"));
