import express from 'express';
import ccxt from 'ccxt';
import WebSocket from 'ws';
import fs from 'fs';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = './state.json';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ================= EXCHANGE =================
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
        coinData: {},
        priceHistory: {},
        market: [],
        positions: [],
        stats: {
            openPositions: 0,
            totalClosed: 0,
            totalDca: 0,
            totalPnl: 0
        }
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
            totalWalletBalance: b.total?.USDT || 0,
            availableBalance: b.free?.USDT || 0,
            totalUnrealizedProfit: b.info?.totalUnrealizedProfit || 0
        };

    } catch (e) {
        log('wallet error ' + e.message);
    }
}

// ================= FAST CHANGE ENGINE =================
function calcChangeFast(arr, min) {
    if (!arr || arr.length < 2) return 0;

    const now = Date.now();
    const cutoff = now - min * 60000;

    let i = arr.length - 1;
    while (i >= 0 && arr[i].t > cutoff) i--;

    const start = arr[i] || arr[0];
    const last = arr[arr.length - 1];

    return ((last.p - start.p) / start.p) * 100;
}

// ================= WS ENGINE 9000 =================
async function startWS() {

    const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const data = await res.json();

    const symbols = data.symbols
        .filter(s =>
            s.symbol.endsWith('USDT') &&
            s.contractType === 'PERPETUAL'
        )
        .map(s => s.symbol.toLowerCase());

    console.log("TOTAL SYMBOLS:", symbols.length);

    const streams = symbols.map(s => `${s}@miniTicker`).join('/');

    const ws = new WebSocket(
        `wss://fstream.binance.com/stream?streams=${streams}`
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

        const arr = state.priceHistory[symbol];

        arr.push({ p: price, t: now });
        if (arr.length > 800) arr.shift();

        const c1 = calcChangeFast(arr, 1);
        const c5 = calcChangeFast(arr, 5);
        const c15 = calcChangeFast(arr, 15);

        state.coinData[symbol] = {
            symbol,
            price,
            c1,
            c5,
            c15,
            vol: Math.abs(c1) + Math.abs(c5) + Math.abs(c15),
            snapshot: { c1, c5, c15 }
        };
    });

    ws.on('close', () => {
        log('WS RECONNECT');
        setTimeout(startWS, 1000);
    });

    ws.on('error', () => ws.close());
}

// ================= TOP 10 MARKET =================
function buildMarket() {

    const arr = Object.values(state.coinData);

    state.market = arr
        .filter(x => x && x.price)
        .sort((a, b) => (b.vol || 0) - (a.vol || 0))
        .slice(0, 10)
        .map(x => ({
            symbol: x.symbol,
            price: x.price,
            c1: x.c1,
            c5: x.c5,
            c15: x.c15
        }));
}

// ================= POSITIONS =================
function updatePositions() {

    state.stats.openPositions = state.positions.length;

    for (let p of state.positions) {

        const price = state.coinData[p.symbol]?.price || p.entryInitial;

        const diff = ((price - p.entryInitial) / p.entryInitial) * 100;

        p.currentPrice = price;

        p.pnl = p.side === 'LONG'
            ? diff * (p.lev || 1)
            : -diff * (p.lev || 1);
    }
}

// ================= LOOP =================
setInterval(() => {
    buildMarket();
    updatePositions();
}, 200);

setInterval(syncWallet, 5000);
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

// ================= CONTROL =================
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
    log('CONFIG UPDATE');
    res.json({ ok: true });
});

app.post('/api/closeall', (req, res) => {
    state.positions = [];
    log('CLOSE ALL');
    res.json({ ok: true });
});

// ================= START =================
app.listen(PORT, async () => {
    console.log(`🚀 RUNNING http://localhost:${PORT}`);

    await syncWallet();
    startWS();
});
