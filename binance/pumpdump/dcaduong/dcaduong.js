import express from 'express';
import ccxt from 'ccxt';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = './state.json';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ================= BINANCE =================
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

// ================= STATE =================
let state = loadState();

function defaultState() {
    return {
        botStatus: 'STOPPED',
        wallet: {},
        logs: [],
        market: [],
        positions: [],
        stats: {
            openPositions: 0,
            totalClosed: 0,
            totalDca: 0,
            totalPnl: 0
        },
        coinData: {},
        priceHistory: {}
    };
}

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE));
        }
    } catch {}
    return defaultState();
}

function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch {}
}

// ================= LOG =================
function log(msg, symbol = '') {
    state.logs.unshift({
        time: new Date().toLocaleTimeString('vi-VN'),
        msg,
        symbol
    });

    if (state.logs.length > 200) state.logs.pop();
}

// ================= WALLET =================
async function syncWallet() {
    try {
        const b = await exchange.fetchBalance();

        state.wallet = {
            totalWalletBalance: b.total?.USDT || b.info?.totalWalletBalance || 0,
            availableBalance: b.free?.USDT || b.info?.availableBalance || 0,
            totalUnrealizedProfit: b.info?.totalUnrealizedProfit || 0
        };

    } catch (e) {
        log('wallet error ' + e.message);
    }
}

// ================= PRICE CHANGE =================
function calcChange(arr, min) {
    if (!arr || arr.length < 2) return 0;

    const now = Date.now();
    const start = arr.find(x => x.t >= now - min * 60000) || arr[0];

    return ((arr[arr.length - 1].p - start.p) / start.p) * 100;
}

// ================= WS =================
async function startWS() {

    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const tickers = await res.json();

    const streams = tickers
        .filter(t => t.symbol.endsWith('USDT'))
        .slice(0, 120)
        .map(t => t.symbol.toLowerCase() + '@ticker');

    const ws = new WebSocket(
        `wss://fstream.binance.com/stream?streams=${streams.join('/')}`
    );

    ws.on('open', () => log('WS CONNECTED'));

    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (!msg.data) return;

        const t = msg.data;
        const symbol = t.s;
        const price = parseFloat(t.c);
        const now = Date.now();

        if (!state.priceHistory[symbol]) {
            state.priceHistory[symbol] = [];
        }

        state.priceHistory[symbol].push({ p: price, t: now });

        if (state.priceHistory[symbol].length > 1000) {
            state.priceHistory[symbol].shift();
        }

        const c1 = calcChange(state.priceHistory[symbol], 1);
        const c5 = calcChange(state.priceHistory[symbol], 5);
        const c15 = calcChange(state.priceHistory[symbol], 15);

        state.coinData[symbol] = {
            symbol,
            price,
            c1,
            c5,
            c15,
            snapshot: { c1, c5, c15 }
        };
    });

    ws.on('close', () => setTimeout(startWS, 1000));
}

// ================= MARKET TOP 10 =================
function buildMarket() {

    const arr = Object.values(state.coinData || []);

    state.market = arr
        .sort((a, b) =>
            (Math.abs(b.c1) + Math.abs(b.c5) + Math.abs(b.c15)) -
            (Math.abs(a.c1) + Math.abs(a.c5) + Math.abs(a.c15))
        )
        .slice(0, 10);
}

// ================= POSITION UPDATE =================
function updatePositionsLive() {

    state.stats.openPositions = state.positions.length;

    for (let p of state.positions) {

        const price = state.coinData[p.symbol]?.price || p.entryInitial;

        const diff = ((price - p.entryInitial) / p.entryInitial) * 100;

        p.currentPrice = price;

        p.pnl =
            p.side === 'LONG'
                ? diff * p.lev
                : -diff * p.lev;
    }
}

// ================= LOOP FAST =================
setInterval(() => {
    buildMarket();
    updatePositionsLive();
}, 200);

// ================= WALLET LOOP =================
setInterval(syncWallet, 5000);

// ================= SAVE =================
setInterval(saveState, 3000);

// ================= API =================
app.get('/api/status', (req, res) => {

    res.json({
        botStatus: state.botStatus,

        wallet: state.wallet,

        logs: state.logs,

        market: state.market,

        activePositions: state.positions,

        stats: state.stats
    });
});

// ================= BOT CONTROL =================
app.post('/api/start', (req, res) => {
    state.botStatus = 'RUNNING';
    log('BOT START');
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    state.botStatus = 'STOPPED';
    log('BOT STOP');
    res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
    state.config = { ...state.config, ...req.body };
    log('CONFIG UPDATED');
    res.json({ ok: true });
});

app.post('/api/closeall', (req, res) => {
    state.positions = [];
    log('CLOSE ALL');
    res.json({ ok: true });
});

// ================= START =================
app.listen(PORT, () => {
    console.log(`RUN http://localhost:${PORT}`);
    log('SERVER START');
    startWS();
});
