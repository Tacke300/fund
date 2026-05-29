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

// ================= EXCHANGE =================
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        hedgeMode: true
    }
});

// ================= STATE =================
let botSettings = {
    isRunning: false,
    capital: 5.5,
    volVolatility: 6,
    maxPos: 3,
    dcaPercent: 10,
    tp: 0.5,
    sl: 10,
    leverage: 20
};

let botAlive = true;

let coinData = {};
let realtimePrice = {};
let positions = new Map();
let status = { botLogs: [] };

let walletCache = {
    totalWalletBalance: 0,
    availableBalance: 0,
    totalUnrealizedProfit: 0
};

let exchangeInfo = {};

// ================= LOG =================
function addLog(msg, symbol = '') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });

    status.botLogs.unshift({
        time,
        msg,
        symbol
    });

    if (status.botLogs.length > 80) status.botLogs.pop();
}

// ================= WALLET =================
async function updateWallet() {
    try {
        const acc = await exchange.fetchBalance();

        walletCache = {
            totalWalletBalance: acc.total?.USDT || 0,
            availableBalance: acc.free?.USDT || 0,
            totalUnrealizedProfit: acc.info?.totalUnrealizedProfit || 0
        };
    } catch (e) {}
}

// ================= REALTIME PRICE =================
async function updatePrice() {
    try {
        const tickers = await exchange.fetchTickers();

        for (const [symbol, t] of Object.entries(tickers)) {
            if (!symbol.includes('/USDT')) continue;

            const base = symbol.split('/')[0];
            realtimePrice[base] = t.last;
        }
    } catch (e) {}

    setTimeout(updatePrice, 1000);
}

// ================= CROSS =================
async function setCross(symbol) {
    try {
        await exchange.setMarginMode('cross', symbol);
        addLog(`CROSS OK`, symbol);
    } catch (e) {}
}

// ================= POSITION =================
function buildPosition(symbol, side, qty, entry) {
    return {
        symbol,
        side,
        qty,

        entryInitial: entry,
        avg: entry,
        currentPrice: entry,

        dcaLevel: 0,
        nextDcaPrice: side === 'LONG'
            ? entry * (1 - botSettings.dcaPercent / 100)
            : entry * (1 + botSettings.dcaPercent / 100),

        tp: side === 'LONG'
            ? entry * (1 + botSettings.tp / 100)
            : entry * (1 - botSettings.tp / 100),

        sl: side === 'LONG'
            ? entry * (1 - botSettings.sl / 100)
            : entry * (1 + botSettings.sl / 100),

        lev: botSettings.leverage,
        margin: 'CROSS',

        pnl: 0
    };
}

// ================= OPEN POSITION =================
async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;

    const pair = `${symbol}/USDT`;
    const key = `${symbol}-${side}`;

    if (positions.has(key)) return;

    try {
        await setCross(pair);

        const qty = parseFloat(((botSettings.capital * botSettings.leverage) / price).toFixed(3));

        await exchange.createOrder(
            pair,
            'MARKET',
            side === 'LONG' ? 'BUY' : 'SELL',
            qty,
            undefined,
            { positionSide: side }
        );

        const pos = buildPosition(symbol, side, qty, price);

        positions.set(key, pos);

        addLog(`OPEN ${symbol} ${side} @ ${price}`, symbol);

    } catch (e) {
        addLog(`OPEN ERR: ${e.message}`, symbol);
    }
}

// ================= UPDATE POSITIONS =================
function updatePositions() {
    for (const [key, p] of positions.entries()) {

        const price = realtimePrice[p.symbol];
        if (!price) continue;

        p.currentPrice = price;

        // pnl realtime
        p.pnl = p.side === 'LONG'
            ? ((price - p.entryInitial) / p.entryInitial) * 100
            : ((p.entryInitial - price) / p.entryInitial) * 100;

        // DCA
        const trigger =
            (p.side === 'LONG' && price <= p.nextDcaPrice) ||
            (p.side === 'SHORT' && price >= p.nextDcaPrice);

        if (trigger && p.dcaLevel < 3) {
            p.dcaLevel++;

            const addQty = p.qty * 0.5;
            p.qty += addQty;

            p.avg =
                (p.avg * (p.dcaLevel) + price) / (p.dcaLevel + 1);

            p.nextDcaPrice = p.side === 'LONG'
                ? p.avg * (1 - botSettings.dcaPercent / 100)
                : p.avg * (1 + botSettings.dcaPercent / 100);

            addLog(`DCA ${p.symbol} lvl=${p.dcaLevel}`, p.symbol);
        }

        positions.set(key, p);
    }
}

// ================= MARKET LOOP =================
async function marketLoop() {
    if (!botAlive) return;

    try {
        const pairs = Object.keys(exchangeInfo);

        for (const pair of pairs) {

            const ohlcv = await exchange.fetchOHLCV(pair, '1m', undefined, 20);

            const symbol = pair.split('/')[0];
            const price = ohlcv[19][4];

            const c1 = ((price - ohlcv[18][4]) / ohlcv[18][4]) * 100;
            const c5 = ((price - ohlcv[14][4]) / ohlcv[14][4]) * 100;
            const c15 = ((price - ohlcv[4][4]) / ohlcv[4][4]) * 100;

            const volatilityScore =
                Math.abs(c1) + Math.abs(c5) + Math.abs(c15);

            coinData[pair] = {
                symbol,
                c1,
                c5,
                c15,
                volatilityScore
            };

            if (
                botSettings.isRunning &&
                Math.abs(c15) >= botSettings.volVolatility
            ) {
                await openPosition(symbol, c15 > 0 ? 'LONG' : 'SHORT', price);
            }
        }

        updatePositions();

    } catch (e) {}

    if (botAlive) setTimeout(marketLoop, 4000);
}

// ================= API =================
app.get('/api/status', (req, res) => {
    res.json({
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED',

        wallet: walletCache,

        // TOP 5 BIẾN ĐỘNG MẠNH NHẤT
        market: Object.values(coinData)
            .sort((a, b) => b.volatilityScore - a.volatilityScore)
            .slice(0, 5),

        realtimePrice,

        activePositions: Array.from(positions.values()),

        status
    });
});

app.post('/api/start', (req, res) => {
    botAlive = true;
    botSettings.isRunning = true;
    marketLoop();
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    botSettings.isRunning = false;
    botAlive = false;
    res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ ok: true });
});

// ================= INIT =================
app.listen(PORT, async () => {
    const markets = await exchange.loadMarkets();

    for (const [k] of Object.entries(markets)) {
        if (k.includes('/USDT')) exchangeInfo[k] = true;
    }

    updatePrice();
    updateWallet();

    setInterval(updateWallet, 5000);

    marketLoop();

    console.log('BOT SYNC RUNNING:', PORT);
});
