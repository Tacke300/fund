import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import fs from 'fs';
import crypto from 'crypto';
import ccxt from 'ccxt';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    headers: { 'X-MBX-APIKEY': API_KEY },
    timeout: 15000
});

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true }
});

let bot = {
    running: false,
    capital: 5.5,
    vol: 6,
    maxPos: 3,
    dcaStep: 10,
    tp: 0.5,
    sl: 10
};

let ip = "UNKNOWN";

let coin = {};
let positions = new Map();
let logs = [];
let closedPnL = 0;

function log(msg) {
    logs.unshift({ t: new Date().toLocaleTimeString(), msg });
    if (logs.length > 200) logs.pop();
}

async function wsAll() {
    const r = await binanceApi.get('/fapi/v1/ticker/price');
    const symbols = r.data.filter(x => x.symbol.endsWith('USDT')).map(x => x.symbol.toLowerCase());
    const chunk = 60;
    for (let i = 0; i < symbols.length; i += chunk) {
        const list = symbols.slice(i, i + chunk).join('/');
        const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${list}@ticker`);
        ws.on('message', m => {
            const d = JSON.parse(m);
            if (!d.data) return;
            update(d.data.s, parseFloat(d.data.c));
        });
    }
}

function update(symbol, price) {
    if (!coin[symbol]) coin[symbol] = { p: [] };
    coin[symbol].p.push(price);
    if (coin[symbol].p.length > 200) coin[symbol].p.shift();
    coin[symbol].price = price;
}

function change(arr, n) {
    if (!arr || arr.length < 2) return 0;
    const old = arr[0];
    const cur = arr[arr.length - 1];
    return ((cur - old) / old) * 100;
}

async function tradeLoop() {
    if (!bot.running) return setTimeout(tradeLoop, 1000);

    const list = Object.keys(coin);

    for (let s of list) {
        if (positions.size >= bot.maxPos) break;

        const p = coin[s]?.price;
        const arr = coin[s]?.p;
        if (!p || !arr) continue;

        const c1 = change(arr.slice(-10));
        const c5 = change(arr.slice(-30));

        const vol = Math.max(Math.abs(c1), Math.abs(c5));

        if (vol < bot.vol) continue;

        const side = (c1 + c5) >= 0 ? "LONG" : "SHORT";

        open(s, side, p);
        break;
    }

    setTimeout(tradeLoop, 1000);
}

async function open(symbol, side, price, dca = null) {

    const margin = Math.max(bot.capital, 5.5);
    const lev = 20;
    const qty = (margin * lev) / price;

    const tpPrice = side === "LONG"
        ? price * (1 + bot.tp / 100)
        : price * (1 - bot.tp / 100);

    const slPrice = side === "LONG"
        ? price * (1 - bot.sl / 100)
        : price * (1 + bot.sl / 100);

    const nextDca = side === "LONG"
        ? price * (1 + bot.dcaStep / 100)
        : price * (1 - bot.dcaStep / 100);

    positions.set(symbol + side, {
        symbol,
        side,
        margin,
        qty,
        lev,
        entry: price,
        tp: tpPrice,
        sl: slPrice,
        avg: price,
        nextDca,
        dca: 0,
        vol
    });

    log(`📌 OPEN ${symbol} ${side} margin:${margin} qty:${qty.toFixed(6)} lev:${lev} entry:${price} tp:${tpPrice} sl:${slPrice} dcaNext:${nextDca}`);

}

async function monitor() {

    for (let [k, p] of positions) {

        const price = coin[p.symbol]?.price;
        if (!price) continue;

        if (p.side === "LONG") {

            if (price >= p.tp) close(k, price, "TP");
            else if (price <= p.sl) close(k, price, "SL");

        } else {

            if (price <= p.tp) close(k, price, "TP");
            else if (price >= p.sl) close(k, price, "SL");
        }

        if (p.dca < 3) {

            const hit = p.side === "LONG"
                ? price >= p.nextDca
                : price <= p.nextDca;

            if (hit) {

                p.dca++;

                p.avg = (p.avg + price) / 2;

                p.nextDca = p.side === "LONG"
                    ? price * (1 + bot.dcaStep / 100)
                    : price * (1 - bot.dcaStep / 100);

                log(`💵 DCA ${p.symbol} ${p.side} price:${price} avg:${p.avg} nextDca:${p.nextDca}`);

            }
        }

        const avgTarget = p.side === "LONG"
            ? p.avg * 1.01
            : p.avg * 0.99;

        if (
            (p.side === "LONG" && price >= avgTarget) ||
            (p.side === "SHORT" && price <= avgTarget)
        ) {
            close(k, price, "AVG");
        }
    }

    setTimeout(monitor, 1000);
}

function close(key, price, type) {

    const p = positions.get(key);

    const pnl = ((price - p.entry) / p.entry) * 100 * p.lev - 0.1;

    closedPnL += pnl;

    log(`💲 CLOSE ${p.symbol} ${type} pnl:${pnl.toFixed(2)}% entry:${p.entry} exit:${price}`);

    positions.delete(key);
}

const app = express();
app.use(express.json());

app.get('/api/status', (req, res) => {
    res.json({
        ip,
        bot,
        positions: Array.from(positions.values()),
        logs,
        closedPnL
    });
});

app.post('/api/start', (req, res) => {
    bot.running = true;
    log("🚀 START");
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    bot.running = false;
    log("⛔ STOP");
    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(PORT);
    wsAll();
    tradeLoop();
    monitor();
});
