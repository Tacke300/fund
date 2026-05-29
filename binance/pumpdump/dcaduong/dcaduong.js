import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import crypto from 'crypto';
import ccxt from 'ccxt';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    headers: { 'X-MBX-APIKEY': API_KEY },
    timeout: 15000
});

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        dualSidePosition: true
    }
});

let botSettings = {
    isRunning: false,
    capital: 5.5,
    volVolatility: 6.5,
    maxPos: 3,
    maxDca: 3,
    dcaPercent: 10,
    tp: 0.5,
    sl: 10
};

let coinData = {};
let positions = new Map();
let logs = [];
let closedPnL = 0;

let status = {
    botLogs: [],
    candidatesList: [],
    botClosedCount: 0,
    totalClosedPnL: 0
};

// ================= LOG =================
function addLog(msg) {
    logs.unshift({
        time: new Date().toLocaleTimeString(),
        msg
    });
    if (logs.length > 200) logs.pop();
}

// ================= PRICE UPDATE =================
function update(symbol, price) {
    if (!coinData[symbol]) coinData[symbol] = { p: [] };

    coinData[symbol].p.push(price);
    if (coinData[symbol].p.length > 200) coinData[symbol].p.shift();

    coinData[symbol].price = price;
}

function change(arr) {
    if (!arr || arr.length < 2) return 0;
    return ((arr[arr.length - 1] - arr[0]) / arr[0]) * 100;
}

// ================= WS ALL COIN =================
async function wsAll() {
    const res = await binanceApi.get('/fapi/v1/ticker/price');
    const symbols = res.data
        .filter(x => x.symbol.endsWith('USDT'))
        .map(x => x.symbol.toLowerCase());

    const chunk = 60;

    for (let i = 0; i < symbols.length; i += chunk) {
        const list = symbols.slice(i, i + chunk).join('/');
        const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${list}@ticker`);

        ws.on('message', msg => {
            const d = JSON.parse(msg);
            if (!d.data) return;
            update(d.data.s, parseFloat(d.data.c));
        });
    }
}

// ================= CANDIDATES =================
function buildCandidates() {
    const arr = [];

    for (let s in coinData) {
        if (!coinData[s]?.p) continue;

        const p = coinData[s].p;

        arr.push({
            symbol: s,
            c1: change(p.slice(-10)),
            c5: change(p.slice(-30)),
            c15: change(p.slice(-60))
        });
    }

    return arr
        .sort((a, b) => Math.abs(b.c1) - Math.abs(a.c1))
        .slice(0, 15);
}

// ================= OPEN POSITION =================
function open(symbol, side, price) {

    if (positions.size >= botSettings.maxPos) return;

    const margin = Math.max(botSettings.capital, 5.5);
    const lev = 20;
    const qty = (margin * lev) / price;

    const tp = side === "LONG"
        ? price * (1 + botSettings.tp / 100)
        : price * (1 - botSettings.tp / 100);

    const sl = side === "LONG"
        ? price * (1 - botSettings.sl / 100)
        : price * (1 + botSettings.sl / 100);

    const nextDca = side === "LONG"
        ? price * (1 + botSettings.dcaPercent / 100)
        : price * (1 - botSettings.dcaPercent / 100);

    positions.set(symbol + side, {
        symbol,
        side,
        entry: price,
        avg: price,
        qty,
        lev,
        margin,
        tp,
        sl,
        nextDca,
        dca: 0
    });

    addLog(`📌 OPEN ${symbol} ${side} margin:${margin} qty:${qty.toFixed(6)} lev:${lev} entry:${price} tp:${tp} sl:${sl} nextDca:${nextDca}`);
}

// ================= MONITOR =================
function monitor() {

    for (let [k, p] of positions) {

        const price = coinData[p.symbol]?.price;
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
                    ? price * (1 + botSettings.dcaPercent / 100)
                    : price * (1 - botSettings.dcaPercent / 100);

                addLog(`💵 DCA ${p.symbol} ${p.side} price:${price} avg:${p.avg}`);
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

// ================= CLOSE =================
function close(key, price, type) {

    const p = positions.get(key);

    const pnl =
        ((price - p.entry) / p.entry) * 100 * p.lev - 0.1;

    closedPnL += pnl;

    addLog(`💲 CLOSE ${p.symbol} ${type} pnl:${pnl.toFixed(2)}% entry:${p.entry} exit:${price}`);

    positions.delete(key);
}

// ================= AUTO TRADE =================
function autoTrade() {

    const list = buildCandidates();

    status.candidatesList = list;

    for (let c of list) {

        const maxV = Math.max(
            Math.abs(c.c1),
            Math.abs(c.c5),
            Math.abs(c.c15)
        );

        if (maxV < botSettings.volVolatility) continue;

        const side = (c.c1 + c.c5 + c.c15) >= 0 ? "LONG" : "SHORT";

        const price = coinData[c.symbol]?.price;

        if (!price) continue;

        open(c.symbol, side, price);

        break;
    }

    setTimeout(autoTrade, 1000);
}

// ================= API =================
app.get('/api/status', (req, res) => {

    const wallet = {
        totalWalletBalance: "0.00",
        availableBalance: "0.00",
        totalUnrealizedProfit: "0.00"
    };

    res.json({
        wallet,
        activePositions: Array.from(positions.values()),
        status: {
            botLogs: logs,
            candidatesList: status.candidatesList,
            botClosedCount: status.botClosedCount,
            totalClosedPnL: closedPnL
        }
    });
});

app.post('/api/start', (req, res) => {
    botSettings.isRunning = true;
    addLog("🚀 START");
    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
    botSettings.isRunning = false;
    addLog("⛔ STOP");
    res.json({ ok: true });
});

// ================= INIT =================
app.listen(PORT, () => {
    console.log("RUN", PORT);
    wsAll();
    monitor();
    autoTrade();
});
