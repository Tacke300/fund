
import express from 'express';
import axios from 'axios';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', hedgeMode: true, recvWindow: 60000, adjustForTimeDifference: true }
});

let botSettings = { isRunning: false, capital: 5, volVolatility: 6.5, maxPos: 3, dcaPercent: 10, tp: 0.5, sl: 10 };
let coinData = {};
let positions = new Map();
let status = { botLogs: [] };
let walletCache = { totalWalletBalance: '0.00', availableBalance: '0.00', totalUnrealizedProfit: '0.00' };
let marketReady = false;
let exchangeInfo = {};
const recentLogs = new Set();

function toCCXTSymbol(symbol) { return symbol.replace('USDT', '/USDT:USDT'); }

function addLog(msg, symbol = '', side = '') {
    const logKey = crypto.createHash('md5').update(`${msg}${symbol}${side}`).digest('hex');
    if (recentLogs.has(logKey)) return;
    recentLogs.add(logKey);
    setTimeout(() => recentLogs.delete(logKey), 5000);
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, symbol, side });
    if (status.botLogs.length > 300) status.botLogs.pop();
    console.log(`[${time}] ${symbol} ${side} ${msg}`);
}

async function loadExchangeInfo() {
    try {
        const markets = await exchange.loadMarkets();
        for (const [k, v] of Object.entries(markets)) {
            if (!k.includes('/USDT:USDT')) continue;
            exchangeInfo[k] = { minCost: Math.max(v.limits?.cost?.min || 5.5, 5.5), minQty: v.limits?.amount?.min || 0, qtyPrecision: v.precision?.amount || 3, pricePrecision: v.precision?.price || 4 };
        }
        marketReady = true;
        addLog('EXCHANGE READY');
    } catch (e) { addLog(`EXCHANGE ERROR ${e.message}`); }
}

async function preloadWallet() {
    try {
        const acc = await exchange.fetchBalance();
        walletCache = { totalWalletBalance: parseFloat(acc.info?.totalWalletBalance || 0).toFixed(2), availableBalance: parseFloat(acc.info?.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.info?.totalUnrealizedProfit || 0).toFixed(2) };
    } catch (e) { addLog(`WALLET ERROR ${e.message}`); }
}

async function initWS() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
        res.data.filter(s => s.symbol.endsWith('USDT')).forEach(c => {
            const vol = parseFloat(c.priceChangePercent);
            const price = parseFloat(c.lastPrice);
            coinData[c.symbol] = { live: { price, c1: vol / 24, c5: vol / 12, c15: vol / 6 } };
        });
    } catch (e) { addLog(`MARKET ERROR ${e.message}`); }
    setTimeout(initWS, 5000);
}

async function syncTPSL(pair, side, tp, sl) {
    try {
        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
        const precision = exchangeInfo[pair]?.pricePrecision || 4;
        const orders = await exchange.fetchOpenOrders(pair);
        for (const o of orders) { if (o.info.positionSide === side) await exchange.cancelOrder(o.id, pair); }
        await exchange.createOrder(pair, 'TAKE_PROFIT_MARKET', closeSide, undefined, undefined, { positionSide: side, stopPrice: tp.toFixed(precision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(pair, 'STOP_MARKET', closeSide, undefined, undefined, { positionSide: side, stopPrice: sl.toFixed(precision), closePosition: true, workingType: 'MARK_PRICE' });
    } catch (e) { addLog(`TPSL ERROR ${e.message}`, pair, side); }
}

async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;
    const pair = toCCXTSymbol(symbol);
    const key = `${symbol}${side}`;
    if (positions.has(key)) return;
    const info = exchangeInfo[pair];
    if (!info) return;
    let qty = parseFloat(exchange.amountToPrecision(pair, Math.max((botSettings.capital * 20) / price, info.minCost / price, info.minQty)));
    try {
        await exchange.setLeverage(20, pair);
        await exchange.createOrder(pair, 'MARKET', side === 'LONG' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        const tp = side === 'LONG' ? price * (1 + botSettings.tp / 100) : price * (1 - botSettings.tp / 100);
        const sl = side === 'LONG' ? price * (1 - botSettings.sl / 100) : price * (1 + botSettings.sl / 100);
        await syncTPSL(pair, side, tp, sl);
        positions.set(key, { symbol, side, qty, leverage: 20, avg: price, tp, sl, pnl: 0, roi: 0, unrealized: 0, liquidationPrice: 0, markPrice: price, nextDca: side === 'LONG' ? price * (1 - botSettings.dcaPercent / 100) : price * (1 + botSettings.dcaPercent / 100) });
        addLog(`OPEN 20x ${qty}`, symbol, side);
    } catch (e) { addLog(`OPEN ERROR ${e.message}`, symbol, side); }
}

async function positionRiskLoop() {
    try {
        const risk = await exchange.fetchPositions();
        risk.forEach(r => {
            const symbol = r.symbol.replace('/USDT:USDT', 'USDT');
            const side = parseFloat(r.contracts) > 0 ? 'LONG' : 'SHORT';
            const pos = positions.get(`${symbol}${side}`);
            if (pos) {
                pos.roi = parseFloat(r.percentage || 0);
                pos.unrealized = parseFloat(r.unrealizedPnl || 0);
                pos.markPrice = parseFloat(r.markPrice || 0);
                pos.liquidationPrice = parseFloat(r.liquidationPrice || 0);
                pos.avg = parseFloat(r.entryPrice || 0);
            }
        });
    } catch (e) { addLog(`PNL ERROR ${e.message}`); }
    setTimeout(positionRiskLoop, 2000);
}

async function closePosition(p) {
    try {
        await exchange.createOrder(toCCXTSymbol(p.symbol), 'MARKET', p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, undefined, { positionSide: p.side });
        addLog(`CLOSE ${p.roi.toFixed(2)}%`, p.symbol, p.side);
    } catch (e) { addLog(`CLOSE ERROR ${e.message}`, p.symbol, p.side); }
}

async function monitorLoop() {
    for (const [key, p] of positions) {
        const tpHit = p.side === 'LONG' ? p.markPrice >= p.tp : p.markPrice <= p.tp;
        const slHit = p.side === 'LONG' ? p.markPrice <= p.sl : p.markPrice >= p.sl;
        if (tpHit || slHit) { await closePosition(p); positions.delete(key); }
    }
    setTimeout(monitorLoop, 1000);
}

async function autoTradeLoop() {
    if (botSettings.isRunning) {
        for (const [s, v] of Object.entries(coinData)) {
            if (!v.live) continue;
            if (Math.abs(v.live.c1) >= botSettings.volVolatility) {
                await openPosition(s, v.live.c1 >= 0 ? 'LONG' : 'SHORT', v.live.price);
                break;
            }
        }
    }
    setTimeout(autoTradeLoop, 2000);
}

app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });
app.post('/api/start', (req, res) => { botSettings.isRunning = true; addLog('BOT START'); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { botSettings.isRunning = false; addLog('BOT STOP'); res.json({ ok: true }); });
app.post('/api/closeall', async (req, res) => {
    const active = await exchange.fetchPositions();
    for (const p of active) {
        if (parseFloat(p.contracts) > 0) {
            await exchange.createOrder(p.symbol, 'MARKET', p.side === 'long' ? 'SELL' : 'BUY', p.contracts, undefined, { positionSide: p.side });
        }
    }
    positions.clear();
    res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
    res.json({ ready: { market: marketReady, wallet: true }, wallet: walletCache, botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED', activePositions: Array.from(positions.values()), status });
});

app.listen(PORT, async () => {
    console.log(`BOT RUNNING ${PORT}`);
    await loadExchangeInfo();
    await preloadWallet();
    initWS();
    autoTradeLoop();
    monitorLoop();
    positionRiskLoop();
    setInterval(preloadWallet, 10000);
    addLog('SYSTEM READY');
});

