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
app.use(express.static(__dirname));

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', hedgeMode: true, recvWindow: 60000, adjustForTimeDifference: true }
});

let botSettings = { isRunning: false, capital: 5, volVolatility: 6.5, maxPos: 3, tp: 0.5, sl: 10 };
let coinData = {}; 
let positions = new Map();
let status = { botLogs: [] };
let walletCache = { totalWalletBalance: '0.00', availableBalance: '0.00' };
let exchangeInfo = {};

function toCCXTSymbol(symbol) { return symbol.replace('USDT', '/USDT:USDT'); }

function addLog(msg, symbol = '', side = '') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, symbol, side });
    if (status.botLogs.length > 300) status.botLogs.pop();
    console.log(`[${time}] ${symbol} ${side} ${msg}`);
}

// 1. Lấy thông tin thị trường
async function loadExchangeInfo() {
    try {
        const markets = await exchange.loadMarkets();
        for (const [k, v] of Object.entries(markets)) {
            if (!k.includes('/USDT:USDT')) continue;
            exchangeInfo[k] = { pricePrecision: v.precision?.price || 4, minCost: 5.5 };
        }
    } catch (e) { addLog(`EXCHANGE ERR: ${e.message}`); }
}

// 2. Lấy số dư tài khoản (Đã khôi phục)
async function preloadWallet() {
    try {
        const acc = await exchange.fetchBalance();
        walletCache = { 
            totalWalletBalance: parseFloat(acc.info?.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.info?.availableBalance || 0).toFixed(2) 
        };
    } catch (e) { addLog(`WALLET ERR: ${e.message}`); }
}

// 3. Quét biến động (Đã khôi phục logic nến)
async function initWS() {
    try {
        for (const pair of Object.keys(exchangeInfo)) {
            const ohlcv = await exchange.fetchOHLCV(pair, '1m', undefined, 15);
            const open = ohlcv[0][4];
            const close = ohlcv[14][4];
            const vol = ((close - open) / open) * 100;
            coinData[pair] = { vol: vol, price: close };
        }
    } catch (e) { }
    setTimeout(initWS, 5000);
}

// 4. Gửi TP/SL lên sàn (CONTRACT_PRICE)
async function syncTPSL(pair, side, tp, sl) {
    try {
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
        const precision = exchangeInfo[pair]?.pricePrecision || 4;
        const orders = await exchange.fetchOpenOrders(pair);
        for (const o of orders) { if (o.info.positionSide === side) await exchange.cancelOrder(o.id, pair); }
        
        await exchange.createOrder(pair, 'TAKE_PROFIT_MARKET', closeSide, undefined, undefined, { 
            positionSide: side, stopPrice: tp.toFixed(precision), closePosition: true, workingType: 'CONTRACT_PRICE' 
        });
        await exchange.createOrder(pair, 'STOP_MARKET', closeSide, undefined, undefined, { 
            positionSide: side, stopPrice: sl.toFixed(precision), closePosition: true, workingType: 'CONTRACT_PRICE' 
        });
    } catch (e) { addLog(`TPSL ERR: ${e.message}`, pair, side); }
}

// 5. Mở vị thế
async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;
    const pair = toCCXTSymbol(symbol);
    const key = `${symbol}${side}`;
    if (positions.has(key)) return;
    
    let qty = parseFloat(((botSettings.capital * 20) / price).toFixed(3));
    try {
        await exchange.setLeverage(20, pair);
        await exchange.createOrder(pair, 'MARKET', side === 'LONG' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        const tp = side === 'LONG' ? price * (1 + botSettings.tp / 100) : price * (1 - botSettings.tp / 100);
        const sl = side === 'LONG' ? price * (1 - botSettings.sl / 100) : price * (1 + botSettings.sl / 100);
        await syncTPSL(pair, side, tp, sl);
        positions.set(key, { symbol, side, qty, tp, sl });
        addLog(`OPENED ${side} @ ${price}`, symbol, side);
    } catch (e) { addLog(`OPEN ERR: ${e.message}`, symbol, side); }
}

async function autoTradeLoop() {
    if (botSettings.isRunning) {
        for (const [pair, data] of Object.entries(coinData)) {
            if (Math.abs(data.vol) >= botSettings.volVolatility) {
                const s = pair.replace('/USDT:USDT', 'USDT');
                await openPosition(s, data.vol >= 0 ? 'LONG' : 'SHORT', data.price);
            }
        }
    }
    setTimeout(autoTradeLoop, 2000);
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });
app.post('/api/start', (req, res) => { botSettings.isRunning = true; addLog('BOT START'); res.json({ ok: true }); });
app.get('/api/status', (req, res) => { res.json({ wallet: walletCache, positions: Array.from(positions.values()), status }); });

app.listen(PORT, async () => {
    console.log(`Bot running on http://localhost:${PORT}`);
    await loadExchangeInfo();
    await preloadWallet();
    setInterval(preloadWallet, 10000);
    initWS();
    autoTradeLoop();
});
