import express from 'express';
import axios from 'axios';
import ccxt from 'ccxt';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', hedgeMode: true, recvWindow: 60000, adjustForTimeDifference: true }
});

let botSettings = { isRunning: false, capital: 5, volVolatility: 6.5, maxPos: 3, tp: 1.2, sl: 10 };
let coinData = {};
let positions = new Map();
let exchangeInfo = {};

function toCCXTSymbol(symbol) { return symbol.replace('USDT', '/USDT:USDT'); }

function addLog(msg, symbol = '') {
    console.log(`[${new Date().toLocaleTimeString('vi-VN', { hour12: false })}] ${symbol} ${msg}`);
}

async function loadExchangeInfo() {
    const markets = await exchange.loadMarkets();
    for (const [k, v] of Object.entries(markets)) {
        if (!k.includes('/USDT:USDT')) continue;
        exchangeInfo[k] = { pricePrecision: v.precision?.price || 4, stepSize: v.limits?.amount?.min || 0.001 };
    }
}

// Logic gửi TP/SL lên sàn 100% bằng CONTRACT_PRICE
async function syncTPSL(symbol, side, tpPrice, slPrice) {
    const pair = toCCXTSymbol(symbol);
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    const info = exchangeInfo[pair];

    try {
        const openOrders = await exchange.fetchOpenOrders(pair);
        for (const o of openOrders) {
            if (o.info.positionSide === side && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET')) {
                await exchange.cancelOrder(o.id, pair);
            }
        }

        await exchange.createOrder(pair, 'TAKE_PROFIT_MARKET', closeSide, undefined, undefined, {
            positionSide: side,
            stopPrice: tpPrice.toFixed(info.pricePrecision),
            closePosition: true,
            workingType: 'CONTRACT_PRICE' 
        });

        await exchange.createOrder(pair, 'STOP_MARKET', closeSide, undefined, undefined, {
            positionSide: side,
            stopPrice: slPrice.toFixed(info.pricePrecision),
            closePosition: true,
            workingType: 'CONTRACT_PRICE'
        });
        addLog(`SYNC TP:${tpPrice.toFixed(info.pricePrecision)} SL:${slPrice.toFixed(info.pricePrecision)}`, symbol);
    } catch (e) { addLog(`TPSL ERROR: ${e.message}`, symbol); }
}

async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;
    const pair = toCCXTSymbol(symbol);
    const qty = parseFloat(((botSettings.capital * 20) / price).toFixed(3));
    
    try {
        await exchange.setLeverage(20, pair);
        await exchange.createOrder(pair, 'MARKET', side === 'LONG' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        
        const tp = side === 'LONG' ? price * (1 + botSettings.tp / 100) : price * (1 - botSettings.tp / 100);
        const sl = side === 'LONG' ? price * (1 - botSettings.sl / 100) : price * (1 + botSettings.sl / 100);
        
        await syncTPSL(symbol, side, tp, sl);
        positions.set(`${symbol}${side}`, { symbol, side, tp, sl });
        addLog(`OPENED ${side} @ ${price}`, symbol);
    } catch (e) { addLog(`OPEN ERROR: ${e.message}`, symbol); }
}

// Logic quét biến động nến 1 phút
async function initWS() {
    try {
        const markets = Object.keys(exchangeInfo);
        for (const m of markets) {
            const ohlcv = await exchange.fetchOHLCV(m, '1m', undefined, 15);
            const close = ohlcv[14][4];
            const open = ohlcv[0][4];
            const vol = Math.abs((close - open) / open * 100);
            if (vol >= botSettings.volVolatility) {
                const s = m.replace('/USDT:USDT', 'USDT');
                await openPosition(s, close > open ? 'LONG' : 'SHORT', close);
            }
        }
    } catch (e) { }
    setTimeout(initWS, 5000);
}

app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });
app.post('/api/start', (req, res) => { botSettings.isRunning = true; res.json({ ok: true }); });

app.listen(PORT, async () => {
    await loadExchangeInfo();
    initWS();
    console.log(`Bot running on ${PORT}`);
});
