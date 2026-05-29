import express from 'express'; import axios from 'axios'; import ccxt from 'ccxt'; import fs from 'fs'; import path from 'path'; import os from 'os'; import crypto from 'crypto'; import { fileURLToPath } from 'url'; import { API_KEY, SECRET_KEY } from './config.js'; 

const PORT = 1114; 
const __dirname = path.dirname(fileURLToPath(import.meta.url)); 
const app = express(); app.use(express.json()); app.use(express.static(__dirname)); 

const exchange = new ccxt.binance({
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true,
    options: { defaultType: 'future', hedgeMode: true, recvWindow: 60000, adjustForTimeDifference: true }
});

let botSettings = { isRunning: false, capital: 5, volVolatility: 6.5, maxPos: 3, dcaPercent: 10, tp: 0.5, sl: 10 }; 
let coinData = {}; let positions = new Map(); let status = { botLogs: [] }; 
let walletCache = { totalWalletBalance: '0.00', availableBalance: '0.00', totalUnrealizedProfit: '0.00' }; 
let marketReady = false; let exchangeInfo = {}; 
const recentLogs = new Set(); // Bộ lọc chặn spam

function addLog(msg, symbol = '', side = '') {
    const logStr = `${symbol} ${side} ${msg}`;
    const hash = crypto.createHash('md5').update(logStr).digest('hex');
    if (recentLogs.has(hash)) return; // Chặn spam
    recentLogs.add(hash);
    setTimeout(() => recentLogs.delete(hash), 10000); // Giới hạn 10s

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, symbol, side });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${logStr}`);
}

async function syncTPSL(pair, side, tp, sl) {
    try {
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
        const info = exchangeInfo[pair] || { pricePrecision: 4 };
        
        // Hủy các lệnh TP/SL cũ của vị thế này trước khi đặt mới
        const orders = await exchange.fetchOpenOrders(pair);
        for (const o of orders) {
            if (o.info.positionSide === side && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET')) {
                await exchange.cancelOrder(o.id, pair);
            }
        }

        // Đặt TP/SL chuẩn Binance (cần precision đúng)
        await exchange.createOrder(pair, 'TAKE_PROFIT_MARKET', closeSide, undefined, undefined, {
            positionSide: side, stopPrice: tp.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE'
        });
        await exchange.createOrder(pair, 'STOP_MARKET', closeSide, undefined, undefined, {
            positionSide: side, stopPrice: sl.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE'
        });
        addLog('TPSL SET', pair, side);
    } catch (e) {
        addLog(`TPSL ERROR: ${e.message}`, pair, side);
    }
}

async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;
    const pair = symbol.replace('USDT', '/USDT:USDT');
    const key = `${symbol}${side}`;
    if (positions.has(key)) return;

    const info = exchangeInfo[pair];
    const qty = parseFloat(((botSettings.capital * 20) / price).toFixed(info.qtyPrecision));
    
    try {
        await exchange.createOrder(pair, 'MARKET', side === 'LONG' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        
        const tp = side === 'LONG' ? price * (1 + botSettings.tp/100) : price * (1 - botSettings.tp/100);
        const sl = side === 'LONG' ? price * (1 - botSettings.sl/100) : price * (1 + botSettings.sl/100);
        await syncTPSL(pair, side, tp, sl);

        positions.set(key, {
            symbol, side, qty, avg: price, tp, sl,
            roi: 0, pnl: 0, dca: 0, nextDca: side === 'LONG' ? price * 0.95 : price * 1.05
        });
        addLog(`OPEN ${qty}`, symbol, side);
    } catch (e) { addLog(`OPEN ERROR: ${e.message}`, symbol, side); }
}

async function positionRiskLoop() {
    try {
        const risk = await exchange.fetchPositions();
        for (const r of risk) {
            const symbol = r.symbol.replace('/USDT:USDT', 'USDT');
            const side = parseFloat(r.contracts) > 0 ? 'LONG' : 'SHORT';
            const pos = positions.get(`${symbol}${side}`);
            if (pos) {
                pos.pnl = parseFloat(r.unrealizedPnl || 0);
                pos.roi = parseFloat(r.percentage || 0);
                pos.markPrice = parseFloat(r.markPrice || 0);
            }
        }
    } catch (e) {}
    setTimeout(positionRiskLoop, 3000);
}

// Giữ nguyên các hàm: loadExchangeInfo, initWS, monitorLoop, autoTradeLoop, app.listen...
// Đảm bảo hàm monitorLoop của bạn khi xóa vị thế thì dùng cancelAll để tránh treo TP/SL
// ... (Phần code dưới giữ nguyên logic cũ của bạn để đảm bảo tính ổn định)

app.get('/api/status', async (req, res) => {
    res.json({
        wallet: walletCache,
        activePositions: Array.from(positions.values()),
        status: status
    });
});

app.listen(PORT, async () => {
    console.log(`BOT RUNNING ${PORT}`);
    await loadExchangeInfo();
    initWS();
    positionRiskLoop();
    // ... gọi các loop còn lại
});
