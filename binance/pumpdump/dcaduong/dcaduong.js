import express from 'express';
import ccxt from 'ccxt';
import path from 'path';
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

let botSettings = { isRunning: false, capital: 0.001, volVolatility: 3, maxPos: 5, dcaPercent: 2, tp: 6, sl: 10 };
let coinData = {}; 
let positions = new Map();
let status = { botLogs: [] };
let walletCache = { totalWalletBalance: '0.00', availableBalance: '0.00', totalUnrealizedProfit: '0.00' };
let exchangeInfo = {};

function addLog(msg, symbol = '', side = '') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, symbol, side });
    if (status.botLogs.length > 50) status.botLogs.pop();
}

async function loadExchangeInfo() {
    try {
        const markets = await exchange.loadMarkets();
        for (const [k, v] of Object.entries(markets)) {
            if (!k.includes('/USDT:USDT')) continue;
            exchangeInfo[k] = { pricePrecision: v.precision?.price || 4 };
        }
    } catch (e) { addLog(`EXCHANGE ERR: ${e.message}`); }
}

async function preloadWallet() {
    try {
        const acc = await exchange.fetchBalance();
        walletCache = { 
            totalWalletBalance: parseFloat(acc.info?.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.info?.availableBalance || 0).toFixed(2),
            totalUnrealizedProfit: parseFloat(acc.info?.totalUnrealizedProfit || 0).toFixed(2)
        };
    } catch (e) {}
}

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

async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;
    const pair = `${symbol}/USDT:USDT`;
    const key = `${symbol}${side}`;
    if (positions.has(key)) return;
    
    let qty = parseFloat(((botSettings.capital * 20) / price).toFixed(3));
    try {
        await exchange.createOrder(pair, 'MARKET', side === 'LONG' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        const tp = side === 'LONG' ? price * (1 + botSettings.tp / 100) : price * (1 - botSettings.tp / 100);
        const sl = side === 'LONG' ? price * (1 - botSettings.sl / 100) : price * (1 + botSettings.sl / 100);
        await syncTPSL(pair, side, tp, sl);
        positions.set(key, { symbol, side, qty, tp, sl, avg: price, pnl: 0 });
        addLog(`OPENED ${side} @ ${price}`, symbol, side);
    } catch (e) { addLog(`OPEN ERR: ${e.message}`, symbol, side); }
}

async function marketLoop() {
    try {
        for (const pair of Object.keys(exchangeInfo)) {
            const ohlcv = await exchange.fetchOHLCV(pair, '1m', undefined, 15);
            const close = ohlcv[14][4];
            const c1 = ((close - ohlcv[13][4]) / ohlcv[13][4]) * 100;
            const c5 = ((close - ohlcv[9][4]) / ohlcv[9][4]) * 100;
            const c15 = ((close - ohlcv[0][4]) / ohlcv[0][4]) * 100;
            coinData[pair] = { c1, c5, c15, price: close };
            if (botSettings.isRunning && Math.abs(c15) >= botSettings.volVolatility) {
                await openPosition(pair.split('/')[0], c15 >= 0 ? 'LONG' : 'SHORT', close);
            }
        }
    } catch (e) {}
    setTimeout(marketLoop, 5000);
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/status', (req, res) => {
    res.json({ 
        wallet: walletCache, 
        activePositions: Array.from(positions.values()), 
        status: status,
        market: Object.entries(coinData).map(([s, v]) => ({ symbol: s.split('/')[0], ...v })),
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED'
    });
});

app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });
app.post('/api/start', (req, res) => { botSettings.isRunning = true; res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { botSettings.isRunning = false; res.json({ ok: true }); });

app.listen(PORT, async () => {
    await loadExchangeInfo();
    preloadWallet();
    setInterval(preloadWallet, 10000);
    marketLoop();
    console.log(`Bot running on http://localhost:${PORT}`);
});
