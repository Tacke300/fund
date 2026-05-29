import express from 'express';
import ccxt from 'ccxt';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATE_FILE = './bot_state.json';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

// ===================== STATE =====================

let state = loadState();

function defaultState() {
    return {
        botSettings: {
            isRunning: false,
            capital: 5,
            volVolatility: 6,
            maxPos: 5,
            tp: 0.5,
            sl: 10,
            leverage: 20,
            dcaPercent: 10
        },
        wallet: {},
        logs: [],
        coinData: {},
        priceHistory: {},
        realtimePrice: {},
        positions: [],
        stats: {
            totalClosed: 0,
            totalPnl: 0,
            totalDca: 0
        }
    };
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE));
        }
    } catch (e) {}
    return defaultState();
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
}

// ===================== LOG =====================

function log(msg) {
    state.logs.unshift({
        t: new Date().toLocaleTimeString(),
        msg
    });
    if (state.logs.length > 200) state.logs.pop();
}

// ===================== WALLET =====================

async function syncWallet() {
    try {
        const b = await exchange.fetchBalance();
        state.wallet = {
            total: b.info.totalMarginBalance,
            free: b.info.availableBalance,
            pnl: b.info.totalUnrealizedProfit
        };
    } catch (e) {}
}

// ===================== PRICE CHANGE =====================

function calcChange(arr, min) {
    if (!arr || arr.length < 2) return 0;

    const now = Date.now();
    const from = arr.find(x => x.t >= now - min * 60000) || arr[0];

    const last = arr[arr.length - 1];

    return ((last.p - from.p) / from.p) * 100;
}

// ===================== WS =====================

async function startWS() {

    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const tickers = await res.json();

    const symbols = tickers
        .filter(t => t.symbol.endsWith('USDT'))
        .slice(0, 150)
        .map(t => t.symbol.toLowerCase() + '@ticker');

    const ws = new WebSocket(
        `wss://fstream.binance.com/stream?streams=${symbols.join('/')}`
    );

    ws.on('open', () => log('WS CONNECTED'));

    ws.on('message', (raw) => {

        const msg = JSON.parse(raw);
        if (!msg.data) return;

        const t = msg.data;

        // 🔥 FIX: giữ nguyên USDT KEY
        const symbol = t.s; // BTCUSDT
        const price = parseFloat(t.c);
        const now = Date.now();

        state.realtimePrice[symbol] = price;

        if (!state.priceHistory[symbol]) {
            state.priceHistory[symbol] = [];
        }

        state.priceHistory[symbol].push({ p: price, t: now });

        if (state.priceHistory[symbol].length > 1000)
            state.priceHistory[symbol].shift();

        const c1 = calcChange(state.priceHistory[symbol], 1);
        const c5 = calcChange(state.priceHistory[symbol], 5);
        const c15 = calcChange(state.priceHistory[symbol], 15);

        state.coinData[symbol] = {
            symbol,
            currentPrice: price,
            c1,
            c5,
            c15,
            vol: Math.abs(c1) + Math.abs(c5) + Math.abs(c15)
        };

        saveState();
    });

    ws.on('close', () => setTimeout(startWS, 1000));
}

// ===================== API =====================

app.get('/api/status', (req, res) => {

    const top10 = Object.values(state.coinData)
        .sort((a, b) => b.vol - a.vol)
        .slice(0, 10);

    res.json({
        botStatus: state.botSettings.isRunning ? 'RUNNING' : 'STOP',
        wallet: state.wallet,
        logs: state.logs,
        market: top10,
        positions: state.positions,
        stats: state.stats,
        config: state.botSettings,
        realtimePrice: state.realtimePrice
    });
});

app.post('/api/start', (req, res) => {
    state.botSettings.isRunning = true;
    log('BOT START');
    saveState();
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    state.botSettings.isRunning = false;
    log('BOT STOP');
    saveState();
    res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
    state.botSettings = { ...state.botSettings, ...req.body };
    log('CONFIG UPDATED');
    saveState();
    res.json({ ok: true });
});

// ===================== LOOP =====================

setInterval(syncWallet, 5000);

setInterval(() => {
    saveState();
}, 3000);

app.listen(PORT, () => {
    log(`SERVER RUN ${PORT}`);
    startWS();
});
