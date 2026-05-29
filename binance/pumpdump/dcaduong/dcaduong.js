import express from 'express';
import axios from 'axios';
import ccxt from 'ccxt';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', hedgeMode: true }
});

let botSettings = { isRunning: false, capital: 5, volVolatility: 6.5, maxPos: 3, dcaPercent: 10, tp: 0.5, sl: 10 };
let coinData = {};
let positions = new Map();
let status = { botLogs: [] };
const recentLogs = new Set();

function addLog(msg, symbol = '', side = '') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logEntry = { time, msg, symbol, side };
    status.botLogs.unshift(logEntry);
    if (status.botLogs.length > 300) status.botLogs.pop();
    console.log(`[${time}] ${symbol} ${side} ${msg}`);
}

async function updateMarketData() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
        res.data.forEach(c => {
            if (!c.symbol.endsWith('USDT')) return;
            const vol = Math.abs(parseFloat(c.priceChangePercent));
            coinData[c.symbol] = { price: parseFloat(c.lastPrice), vol: vol };
        });
    } catch (e) { }
    setTimeout(updateMarketData, 3000);
}

async function syncPositions() {
    try {
        const rawPositions = await exchange.fetchPositions();
        rawPositions.forEach(p => {
            if (parseFloat(p.contracts) > 0) {
                const key = `${p.symbol}_${p.side}`;
                positions.set(key, {
                    symbol: p.symbol,
                    side: p.side,
                    qty: parseFloat(p.contracts),
                    leverage: p.leverage,
                    entryPrice: parseFloat(p.entryPrice),
                    markPrice: parseFloat(p.markPrice),
                    pnl: parseFloat(p.unrealizedPnl),
                    roi: parseFloat(p.percentage),
                    liquidationPrice: parseFloat(p.liquidationPrice),
                    nextDca: p.side === 'long' ? parseFloat(p.entryPrice) * 0.9 : parseFloat(p.entryPrice) * 1.1
                });
            } else {
                positions.delete(`${p.symbol}_${p.side}`);
            }
        });
    } catch (e) { }
    setTimeout(syncPositions, 2000);
}

async function openPosition(symbol, side, price) {
    if (!botSettings.isRunning || positions.size >= botSettings.maxPos) return;
    try {
        let qty = parseFloat(((botSettings.capital * 20) / price).toFixed(3));
        await exchange.createOrder(symbol, 'MARKET', side === 'LONG' ? 'BUY' : 'SELL', qty, undefined, { positionSide: side });
        addLog(`OPEN 20x ${qty}`, symbol, side);
    } catch (e) { addLog(`OPEN ERR: ${e.message}`, symbol); }
}

app.post('/api/closeall', async (req, res) => {
    try {
        const active = await exchange.fetchPositions();
        for (let p of active) {
            if (parseFloat(p.contracts) > 0) {
                await exchange.createOrder(p.symbol, 'MARKET', p.side === 'long' ? 'SELL' : 'BUY', p.contracts, undefined, { positionSide: p.side });
            }
        }
        positions.clear();
        addLog('ALL POSITIONS CLOSED');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/start', (req, res) => { botSettings.isRunning = true; addLog('BOT START'); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { botSettings.isRunning = false; addLog('BOT STOP'); res.json({ ok: true }); });
app.post('/api/config', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ ok: true }); });

app.get('/api/status', (req, res) => {
    res.json({
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED',
        activePositions: Array.from(positions.values()),
        logs: status.botLogs
    });
});

app.listen(PORT, async () => {
    console.log(`BOT RUNNING ${PORT}`);
    updateMarketData();
    syncPositions();
});
