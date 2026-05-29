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
// BINANCE FUTURES
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

let coinData = {};
let positions = new Map();
let status = { botLogs: [] };

// =========================
// LOG SYSTEM
// =========================
let logCache = new Set();

function addLog(msg, symbol = null, side = null) {

    const key = msg + symbol + side;
    if (logCache.has(key)) return;

    logCache.add(key);
    setTimeout(() => logCache.delete(key), 4000);

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });

    status.botLogs.unshift({ time, msg, symbol, side });
    if (status.botLogs.length > 200) status.botLogs.pop();

    console.log(`[${time}] ${symbol || ''} ${msg}`);
}

// =========================
// SAVE
// =========================
function saveState() {
    fs.writeFileSync('config_data.json', JSON.stringify(botSettings, null, 2));
    fs.writeFileSync('positions.json', JSON.stringify(Array.from(positions.values()), null, 2));
}

// =========================
// MARKET DATA
// =========================
function change(arr, min) {
    if (!arr || arr.length < 2) return 0;
    const now = Date.now();
    const start = arr.find(i => i.t >= now - min * 60000) || arr[0];
    return ((arr.at(-1).p - start.p) / start.p) * 100;
}

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
            c15: change(coinData[s].prices, 15)
        };
    });

    ws.on('close', () => setTimeout(initWS, 3000));
}

// =========================
// OPEN POSITION
// =========================
async function openPosition(symbol, side, price) {

    const key = `${symbol}_${side}`;

    if (!botSettings.isRunning) return;
    if (positions.has(key)) return;

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

    addLog(`OPEN`, symbol, side);
    saveState();
}

// =========================
// MONITOR
// =========================
async function monitorLoop() {

    for (const [key, p] of positions) {

        const cp = coinData[p.symbol]?.live?.price;
        if (!cp) continue;

        const pnl =
            p.side === 'LONG'
                ? ((cp - p.avg) / p.avg) * 100
                : ((p.avg - cp) / p.avg) * 100;

        const nextDca =
            p.side === 'LONG'
                ? p.entryInitial * (1 + botSettings.dcaPercent / 100 * (p.dca + 1))
                : p.entryInitial * (1 - botSettings.dcaPercent / 100 * (p.dca + 1));

        const protect =
            p.dca > 0 &&
            (
                p.side === 'LONG'
                    ? cp <= p.avg * 0.99
                    : cp >= p.avg * 1.01
            );

        const tp = p.side === 'LONG' ? cp >= p.tp : cp <= p.tp;
        const sl = p.side === 'LONG' ? cp <= p.sl : cp >= p.sl;

        if (tp || sl || protect) {

            await exchange.createOrder(
                p.symbol,
                'market',
                p.side === 'LONG' ? 'sell' : 'buy',
                p.qty,
                undefined,
                { reduceOnly: true, positionSide: p.side }
            );

            addLog(`CLOSE PNL ${pnl.toFixed(2)}%`, p.symbol, p.side);

            positions.delete(key);
            saveState();
            continue;
        }

        // DCA
        if (p.dca < 3) {

            const trigger =
                p.side === 'LONG'
                    ? cp >= p.entryInitial * (1 + botSettings.dcaPercent / 100 * (p.dca + 1))
                    : cp <= p.entryInitial * (1 - botSettings.dcaPercent / 100 * (p.dca + 1));

            if (trigger) {

                p.dca++;

                const newQty = (botSettings.capital * 20) / cp;

                p.avg = ((p.avg * p.qty) + (cp * newQty)) / (p.qty + newQty);
                p.qty += newQty;

                addLog(`DCA ${p.dca} AVG ${p.avg.toFixed(2)}`, p.symbol, p.side);
            }
        }
    }

    setTimeout(monitorLoop, 1000);
}

// =========================
// AUTO TRADE
// =========================
async function autoTradeLoop() {

    if (!botSettings.isRunning) return setTimeout(autoTradeLoop, 2000);

    for (const [s, v] of Object.entries(coinData)) {

        if (!v.live) continue;

        const { c1, c5, c15 } = v.live;

        const valid =
            Math.abs(c1) > botSettings.volVolatility ||
            Math.abs(c5) > botSettings.volVolatility ||
            Math.abs(c15) > botSettings.volVolatility;

        if (!valid) continue;

        const side =
            (c1 + c5 + c15) >= 0 ? 'LONG' : 'SHORT';

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

        const nextDca =
            p.side === 'LONG'
                ? p.entryInitial * (1 + botSettings.dcaPercent / 100 * (p.dca + 1))
                : p.entryInitial * (1 - botSettings.dcaPercent / 100 * (p.dca + 1));

        return {
            ...p,
            pnl,
            currentPrice: cp,
            nextDca
        };
    });

    res.json({
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED',
        market,
        activePositions,
        status
    });
});

// =========================
app.listen(PORT, () => {
    initWS();
    autoTradeLoop();
    monitorLoop();
    console.log(`BOT RUNNING ${PORT}`);
});
