import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// =========================
// EXCHANGE BINANCE FUTURES
// =========================
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        dualSidePosition: true
    }
});

// =========================
// STATE
// =========================
let botSettings = {
    isRunning: false,
    capital: 5,
    volVolatility: 6,
    maxPos: 3,
    dcaPercent: 10,
    tp: 50,
    sl: 10
};

let positions = new Map();
let coinData = {};
let status = { botLogs: [] };

// =========================
// LOG SYSTEM (NO SPAM)
// =========================
let logCache = new Set();

function addLog(msg) {
    if (logCache.has(msg)) return;

    logCache.add(msg);
    setTimeout(() => logCache.delete(msg), 5000);

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });

    status.botLogs.unshift({ time, msg });
    if (status.botLogs.length > 200) status.botLogs.pop();

    console.log(`[${time}] ${msg}`);
}

// =========================
// SAVE STATE
// =========================
function saveState() {
    fs.writeFileSync('config_data.json', JSON.stringify(botSettings, null, 2));
    fs.writeFileSync('positions.json', JSON.stringify(Array.from(positions.values()), null, 2));
}

// =========================
// PRICE CHANGE CALC
// =========================
function change(arr, min) {
    if (!arr || arr.length < 2) return 0;
    const now = Date.now();
    const start = arr.find(i => i.t >= now - min * 60000) || arr[0];
    return ((arr.at(-1).p - start.p) / start.p) * 100;
}

// =========================
// WEBSOCKET MARKET DATA
// =========================
async function initWS() {

    const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');

    const symbols = res.data
        .filter(t => t.symbol.endsWith('USDT'))
        .map(t => t.symbol.toLowerCase())
        .slice(0, 50);

    const ws = new WebSocket(
        `wss://fstream.binance.com/stream?streams=${symbols.map(s => `${s}@ticker`).join('/')}`
    );

    ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (!msg.data) return;

        const s = msg.data.s;
        const p = parseFloat(msg.data.c);

        if (!coinData[s]) coinData[s] = { prices: [] };

        coinData[s].prices.push({ p, t: Date.now() });
        if (coinData[s].prices.length > 500) coinData[s].prices.shift();

        coinData[s].live = {
            price: p,
            c1: change(coinData[s].prices, 1),
            c5: change(coinData[s].prices, 5),
            c15: change(coinData[s].prices, 15),
            lastUpdate: Date.now()
        };
    });

    ws.on('close', () => setTimeout(initWS, 3000));
}

// =========================
// OPEN POSITION
// =========================
async function openPosition(symbol, side, price) {

    const key = `${symbol}_${side}`;

    if (positions.has(key)) return;
    if (!botSettings.isRunning) return;

    const lev = 20;
    const qty = (botSettings.capital * lev) / price;

    await exchange.setLeverage(lev, symbol);

    await exchange.createOrder(
        symbol,
        'market',
        side === 'LONG' ? 'buy' : 'sell',
        qty,
        undefined,
        { positionSide: side }
    );

    positions.set(key, {
        symbol,
        side,
        qty,
        avg: price,
        entryInitial: price,
        marginInitial: botSettings.capital,
        dca: 0,
        tp: side === 'LONG'
            ? price * (1 + botSettings.tp / 100)
            : price * (1 - botSettings.tp / 100),
        sl: side === 'LONG'
            ? price * (1 - botSettings.sl / 100)
            : price * (1 + botSettings.sl / 100),
        startTime: Date.now()
    });

    addLog(`🚀 OPEN ${symbol} ${side}`);
    saveState();
}

// =========================
// MONITOR LOOP (CORE LOGIC)
// =========================
async function monitorLoop() {

    for (const [key, p] of positions) {

        const cp = coinData[p.symbol]?.live?.price;
        if (!cp) continue;

        // TP
        const tpHit =
            p.side === 'LONG'
                ? cp >= p.tp
                : cp <= p.tp;

        // SL BACKUP
        const slHit =
            p.side === 'LONG'
                ? cp <= p.sl
                : cp >= p.sl;

        // DYNAMIC PROTECT (avg ± 1% entry)
        const protectPrice =
            p.side === 'LONG'
                ? p.avg + p.entryInitial * 0.01
                : p.avg - p.entryInitial * 0.01;

        const protectHit =
            p.dca > 0 &&
            (
                p.side === 'LONG'
                    ? cp <= protectPrice
                    : cp >= protectPrice
            );

        if (tpHit || slHit || protectHit) {

            await exchange.createOrder(
                p.symbol,
                'market',
                p.side === 'LONG' ? 'sell' : 'buy',
                p.qty,
                undefined,
                { reduceOnly: true, positionSide: p.side }
            );

            positions.delete(key);
            addLog(`CLOSE ${p.symbol}`);
            saveState();
            continue;
        }

        // SIMPLE DCA
        if (p.dca < 3) {

            const trigger =
                p.side === 'LONG'
                    ? cp >= p.entryInitial * (1 + botSettings.dcaPercent / 100 * (p.dca + 1))
                    : cp <= p.entryInitial * (1 - botSettings.dcaPercent / 100 * (p.dca + 1));

            if (trigger) {
                await openPosition(p.symbol, p.side, cp);
                p.dca++;
            }
        }
    }

    setTimeout(monitorLoop, 1000);
}

// =========================
// AUTO TRADE LOOP
// =========================
async function autoTradeLoop() {

    if (!botSettings.isRunning) {
        return setTimeout(autoTradeLoop, 2000);
    }

    for (const [s, v] of Object.entries(coinData)) {

        if (!v.live) continue;

        const { c1, c5, c15 } = v.live;

        const valid =
            Math.abs(c1) > botSettings.volVolatility ||
            Math.abs(c5) > botSettings.volVolatility ||
            Math.abs(c15) > botSettings.volVolatility;

        if (!valid) continue;

        const side =
            (c1 + c5 + c15) >= 0
                ? 'LONG'
                : 'SHORT';

        await openPosition(s, side, v.live.price);
        break;
    }

    setTimeout(autoTradeLoop, 2000);
}

// =========================
// API
// =========================
app.post('/api/config', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    saveState();
    res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
    botSettings.isRunning = true;
    saveState();
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    botSettings.isRunning = false;
    saveState();
    res.json({ ok: true });
});

app.get('/api/status', (req, res) => {

    const market = Object.entries(coinData).map(([s, v]) => ({
        symbol: s,
        ...v.live
    }));

    const activePositions = Array.from(positions.values()).map(p => {
        const cp = coinData[p.symbol]?.live?.price || 0;

        const pnl =
            p.side === 'LONG'
                ? ((cp - p.avg) / p.avg) * 100
                : ((p.avg - cp) / p.avg) * 100;

        return { ...p, pnl };
    });

    res.json({
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED',
        market,
        activePositions,
        status,
        wallet: {
            totalWalletBalance: 0,
            availableBalance: 0,
            totalUnrealizedProfit: 0
        }
    });
});

// =========================
// START
// =========================
app.listen(PORT, () => {
    initWS();
    autoTradeLoop();
    monitorLoop();
    console.log(`BOT RUNNING ${PORT}`);
});
