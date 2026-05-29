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

const CONFIG_FILE = path.join(__dirname, 'config_data.json');
const POS_FILE = path.join(__dirname, 'positions.json');

// ==========================
// EXCHANGE
// ==========================
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        dualSidePosition: true,
        recvWindow: 60000
    }
});

// ==========================
// STATE
// ==========================
let botSettings = {
    isRunning: false,
    capital: 1,
    volVolatility: 7,
    maxPos: 3,
    dcaPercent: 10,
    tp: 50
};

if (fs.existsSync(CONFIG_FILE)) {
    botSettings = {
        ...botSettings,
        ...JSON.parse(fs.readFileSync(CONFIG_FILE))
    };
}

let positions = new Map();
let coinData = {};

let blockedCoins = new Map(); // 15m cooldown
let symbolSideLock = new Set(); // chống 2 chiều cùng symbol

let lastDcaTime = new Map(); // anti spam DCA

// ==========================
// LOG
// ==========================
function addLog(msg) {
    const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    console.log(`[${t}] ${msg}`);
}

// ==========================
// SAVE
// ==========================
function saveState() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2));
    fs.writeFileSync(POS_FILE, JSON.stringify(Array.from(positions.values()), null, 2));
}

// ==========================
// WS MARKET DATA
// ==========================
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
        if (coinData[s].prices.length > 1000) coinData[s].prices.shift();

        coinData[s].live = {
            c1: change(coinData[s].prices, 1),
            c5: change(coinData[s].prices, 5),
            c15: change(coinData[s].prices, 15),
            price: p
        };
    });

    ws.on('close', () => setTimeout(initWS, 3000));
}

function change(arr, min) {
    if (arr.length < 2) return 0;
    const now = Date.now();
    const start = arr.find(i => i.t >= now - min * 60000) || arr[0];
    return ((arr.at(-1).p - start.p) / start.p) * 100;
}

// ==========================
// LEVERAGE
// ==========================
async function getLev(symbol) {
    try {
        const m = await exchange.loadMarkets();
        const lev = m[symbol]?.leverage || 20;
        return lev < 20 ? null : lev;
    } catch {
        return null;
    }
}

// ==========================
// OPEN POSITION
// ==========================
async function openPosition(symbol, side, price, isDca = false) {

    const key = `${symbol}_${side}`;

    if (!isDca && positions.has(key)) return;
    if (blockedCoins.get(symbol) > Date.now()) return;

    if (symbolSideLock.has(symbol) && !positions.has(key)) return;

    const lev = await getLev(symbol);
    if (!lev) return;

    let margin = botSettings.capital;

    const pos = positions.get(key);

    if (isDca) {

        const last = lastDcaTime.get(key) || 0;
        if (Date.now() - last < 10000) return;

        margin = pos.marginInitial;
    }

    const qtyRaw = (margin * lev) / price;
    const qty = parseFloat(
        exchange.amountToPrecision(symbol, qtyRaw)
    );

    await exchange.setLeverage(lev, symbol);

    await exchange.createOrder(
        symbol,
        'market',
        side === 'LONG' ? 'buy' : 'sell',
        qty,
        undefined,
        { positionSide: side }
    );

    if (!isDca) {

        positions.set(key, {
            symbol,
            side,
            qty,
            avg: price,
            entryInitial: price,
            marginInitial: margin,
            tp: side === 'LONG'
                ? price * (1 + botSettings.tp / 100)
                : price * (1 - botSettings.tp / 100),
            dca: 0,
            startTime: Date.now()
        });

        symbolSideLock.add(symbol);

        addLog(`OPEN ${symbol} ${side}`);
    }
    else {

        const p = positions.get(key);

        const totalQty = p.qty + qty;

        p.avg =
            (p.avg * p.qty + price * qty)
            / totalQty;

        p.qty = totalQty;
        p.dca++;

        lastDcaTime.set(key, Date.now());

        addLog(`DCA ${symbol} ${side} AVG ${p.avg.toFixed(2)}`);
    }

    saveState();
}

// ==========================
// MONITOR
// ==========================
async function monitorLoop() {

    for (const [key, p] of positions) {

        const cp = coinData[p.symbol]?.live?.price;
        if (!cp) continue;

        // TP (giữ nguyên)
        const tpHit =
            p.side === 'LONG'
                ? cp >= p.tp
                : cp <= p.tp;

        // SL backup
        const slHit =
            p.side === 'LONG'
                ? cp <= p.entryInitial * 0.9
                : cp >= p.entryInitial * 1.1;

        // PROTECT (avg ± 1% entryInitial)
        const protect =
            p.dca > 0 &&
            (
                p.side === 'LONG'
                    ? cp <= p.avg + p.entryInitial * 0.01
                    : cp >= p.avg - p.entryInitial * 0.01
            );

        if (tpHit || slHit || protect) {

            await exchange.createOrder(
                p.symbol,
                'market',
                p.side === 'LONG' ? 'sell' : 'buy',
                p.qty,
                undefined,
                { reduceOnly: true, positionSide: p.side }
            );

            blockedCoins.set(
                p.symbol,
                Date.now() + 15 * 60 * 1000
            );

            symbolSideLock.delete(p.symbol);
            positions.delete(key);

            addLog(`CLOSE ${p.symbol}`);

            saveState();
            continue;
        }

        // PYRAMID (dương)
        if (p.dca < 3) {

            const trigger =
                p.side === 'LONG'
                    ? cp >= p.entryInitial * (1 + botSettings.dcaPercent / 100 * (p.dca + 1))
                    : cp <= p.entryInitial * (1 - botSettings.dcaPercent / 100 * (p.dca + 1));

            if (trigger) {
                await openPosition(p.symbol, p.side, cp, true);
            }
        }
    }

    setTimeout(monitorLoop, 1000);
}

// ==========================
// AUTO TRADE
// ==========================
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

        await openPosition(s, side, v.live.price, false);
        break;
    }

    setTimeout(autoTradeLoop, 2000);
}

// ==========================
// START
// ==========================
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/start', (req,res)=>{
    botSettings.isRunning = true;
    saveState();
    res.json({ok:true});
});

app.post('/api/stop', (req,res)=>{
    botSettings.isRunning = false;
    saveState();
    res.json({ok:true});
});

app.listen(PORT, () => {
    initWS();
    autoTradeLoop();
    monitorLoop();
    console.log("BOT RUNNING");
});
