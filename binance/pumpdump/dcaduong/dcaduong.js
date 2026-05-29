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
    volVolatility: 6.5,
    maxPos: 3,
    dcaPercent: 10,
    tp: 0.5,
    sl: 10,
    leverage: 20
};

let botAlive = true;

let coinData = {};
let positions = new Map();
let status = { botLogs: [] };

let exchangeInfo = {};
let realtimePrice = {};

// ================= LOG =================
function addLog(msg, symbol = '', side = '') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, symbol, side });
    if (status.botLogs.length > 80) status.botLogs.pop();
}

// ================= CROSS MARGIN =================
async function setCross(symbol) {
    try {
        await exchange.setMarginMode('cross', symbol);
        addLog('CROSS OK', symbol);
    } catch (e) {}
}

// ================= REALTIME PRICE =================
async function updateRealtimePrice() {
    try {
        const tickers = await exchange.fetchTickers();

        for (const [symbol, data] of Object.entries(tickers)) {
            if (!symbol.includes('/USDT')) continue;

            const base = symbol.split('/')[0];
            realtimePrice[base] = data.last;
        }
    } catch (e) {}

    setTimeout(updateRealtimePrice, 1000);
}

// ================= POSITION BUILDER =================
function buildPosition(symbol, side, qty, entry) {
    return {
        symbol,
        side,
        qty,

        entryInitial: entry,
        avg: entry,

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

        pnl: 0,
        currentPrice: entry
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

        addLog(
            `OPEN ${symbol} ${side} | lev=${pos.lev} | entry=${price} | tp=${pos.tp.toFixed(4)} | sl=${pos.sl.toFixed(4)} | dca=${pos.nextDcaPrice.toFixed(4)}`,
            symbol,
            side
        );

    } catch (e) {
        addLog(`OPEN ERR: ${e.message}`, symbol, side);
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

        // ================= DCA =================
        const trigger =
            (p.side === 'LONG' && price <= p.nextDcaPrice) ||
            (p.side === 'SHORT' && price >= p.nextDcaPrice);

        if (trigger && p.dcaLevel < 3) {
            p.dcaLevel++;

            const addQty = p.qty * 1.5;
            p.qty += addQty;

            p.avg =
                (p.avg * (p.dcaLevel) + price) / (p.dcaLevel + 1);

            p.nextDcaPrice = p.side === 'LONG'
                ? p.avg * (1 - botSettings.dcaPercent / 100)
                : p.avg * (1 + botSettings.dcaPercent / 100);

            addLog(
                `DCA ${p.symbol} lvl=${p.dcaLevel} avg=${p.avg.toFixed(4)} next=${p.nextDcaPrice.toFixed(4)}`,
                p.symbol,
                p.side
            );
        }

        positions.set(key, p);
    }
}

// ================= MARKET LOOP =================
async function marketLoop() {
    if (!botAlive) return;

    try {
        for (const pair of Object.keys(exchangeInfo)) {
            const ohlcv = await exchange.fetchOHLCV(pair, '1m', undefined, 15);
            const close = ohlcv[14][4];

            const symbol = pair.split('/')[0];

            const c15 = ((close - ohlcv[0][4]) / ohlcv[0][4]) * 100;
            coinData[pair] = { c15 };

            if (botSettings.isRunning && Math.abs(c15) >= botSettings.volVolatility) {
                await openPosition(symbol, c15 > 0 ? 'LONG' : 'SHORT', close);
            }
        }

        updatePositions();

    } catch (e) {}

    if (botAlive) setTimeout(marketLoop, 5000);
}

// ================= API =================
app.get('/api/status', (req, res) => {
    res.json({
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED',

        market: Object.entries(coinData)
            .map(([s, v]) => ({ symbol: s.split('/')[0], ...v }))
            .sort((a, b) => Math.abs(b.c15) - Math.abs(a.c15))
            .slice(0, 10),

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

    updateRealtimePrice();
    marketLoop();

    console.log('BOT RUNNING:', PORT);
});
