
import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import crypto from 'crypto';
import ccxt from 'ccxt';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000 }
});

let timestampOffset = 0;
let botSettings = { isRunning: false, capital: 5.5, volVolatility: 6.5, maxPos: 3, maxDca: 3, dcaPercent: 10, tp: 0.5, sl: 10 };
let coinData = {};
let positions = new Map();
let lastLoggedMsg = "";
let status = { botLogs: [], botClosedCount: 0, totalClosedPnL: 0, totalDcaClosed: 0 };

function addLog(msg) {
    if (msg === lastLoggedMsg) return;
    lastLoggedMsg = msg;
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg });
    if (status.botLogs.length > 300) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Hàm lấy IP Public thay vì IP nội bộ
async function getPublicIP() {
    try {
        const res = await axios.get('https://api.ipify.org?format=json');
        return res.data.ip;
    } catch { return '0.0.0.0'; }
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const res = await axios({ method, url: `https://fapi.binance.com${endpoint}?${query}&signature=${signature}`, headers: { 'X-MBX-APIKEY': API_KEY } });
        return res.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0];
    return parseFloat(((pArr[pArr.length - 1].p - start.p) / start.p * 100).toFixed(2));
}

async function bootstrapData() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        const usdtPairs = res.data.filter(t => t.symbol.endsWith('USDT'));
        for (const t of usdtPairs) {
            try {
                const kRes = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=20`);
                const prices = kRes.data.map(k => ({ p: parseFloat(k[4]), t: parseInt(k[0]) }));
                const currentPrice = prices[prices.length - 1].p;
                coinData[t.symbol] = { symbol: t.symbol, prices: prices, live: { c1: calculateChange(prices, 1), c5: calculateChange(prices, 5), c15: calculateChange(prices, 15), currentPrice: currentPrice } };
            } catch {}
        }
        addLog('✅ BOOTSTRAP: Ready');
    } catch (e) { addLog('⛔ BOOTSTRAP ERROR: ' + e.message); }
}

function updatePriceLogic(symbol, price, now) {
    if (!coinData[symbol]) coinData[symbol] = { symbol, prices: [] };
    coinData[symbol].prices.push({ p: price, t: now });
    if (coinData[symbol].prices.length > 1200) coinData[symbol].prices.shift();
    coinData[symbol].live = { c1: calculateChange(coinData[symbol].prices, 1), c5: calculateChange(coinData[symbol].prices, 5), c15: calculateChange(coinData[symbol].prices, 15), currentPrice: price };
}

async function initWS() {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
    const symbols = res.data.filter(t => t.symbol.endsWith('USDT')).map(t => t.symbol.toLowerCase());
    const chunkSize = 50;
    for (let i = 0; i < symbols.length; i += chunkSize) {
        const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${symbols.slice(i, i + chunkSize).map(s => `${s}@ticker`).join('/')}`);
        ws.on('message', raw => {
            try {
                const msg = JSON.parse(raw);
                if (msg.data) updatePriceLogic(msg.data.s, parseFloat(msg.data.c), Date.now());
            } catch {}
        });
        ws.on('close', () => setTimeout(initWS, 1000));
    }
}

async function fallbackAPI() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        res.data.forEach(t => { if (t.symbol.endsWith('USDT')) updatePriceLogic(t.symbol, parseFloat(t.price), Date.now()); });
    } catch {}
    setTimeout(fallbackAPI, 1000);
}

async function openPosition(symbol, side, currentPrice, isDca = false) {
    try {
        const key = `${symbol}_${side}`;
        if (positions.has(key) && !isDca) return;
        const lev = 20;
        const margin = Math.max(parseFloat(botSettings.capital), 5.5);
        const qty = (margin * lev) / currentPrice;
        await exchange.setLeverage(lev, symbol);
        await exchange.createOrder(symbol, 'market', side === 'LONG' ? 'buy' : 'sell', qty, undefined, { positionSide: side });

        if (!isDca) {
            positions.set(key, { symbol, side, lev, margin, qty, avg: currentPrice, tp: side === 'LONG' ? currentPrice * (1 + botSettings.tp/100) : currentPrice * (1 - botSettings.tp/100), sl: side === 'LONG' ? currentPrice * (1 - botSettings.sl/100) : currentPrice * (1 + botSettings.sl/100), nextDca: side === 'LONG' ? currentPrice * (1 + botSettings.dcaPercent/100) : currentPrice * (1 - botSettings.dcaPercent/100), dca: 0, didDca: false });
        } else {
            const p = positions.get(key);
            p.dca++; p.didDca = true; p.margin += margin; p.qty += qty;
            p.avg = ((p.avg * (p.qty - qty)) + (currentPrice * qty)) / p.qty;
            p.nextDca = side === 'LONG' ? currentPrice * (1 + botSettings.dcaPercent/100) : currentPrice * (1 - botSettings.dcaPercent/100);
        }
    } catch (e) { addLog(`⛔ OPEN ERROR ${symbol} ${e.message}`); }
}

async function closePosition(key, reason, currentPrice) {
    try {
        const p = positions.get(key);
        if (!p) return;
        await exchange.createOrder(p.symbol, 'market', p.side === 'LONG' ? 'sell' : 'buy', p.qty, undefined, { reduceOnly: true, positionSide: p.side });
        positions.delete(key);
        addLog(`💲 ${reason} ${p.symbol}`);
    } catch (e) { addLog(`⛔ CLOSE ERROR ${e.message}`); }
}

async function autoTradeLoop() {
    if (botSettings.isRunning && positions.size < botSettings.maxPos) {
        const market = Object.entries(coinData).filter(([,v]) => v.live).map(([s,v]) => ({ symbol: s, c1: v.live.c1, c5: v.live.c5, c15: v.live.c15, vol: Math.max(Math.abs(v.live.c1), Math.abs(v.live.c5), Math.abs(v.live.c15)) })).sort((a,b) => b.vol - a.vol);
        const best = market[0];
        if (best && best.vol >= botSettings.volVolatility) {
            const side = (best.c1 + best.c5 + best.c15) >= 0 ? 'LONG' : 'SHORT';
            await openPosition(best.symbol, side, coinData[best.symbol].live.currentPrice);
        }
    }
    setTimeout(autoTradeLoop, 1000);
}

async function monitorLoop() {
    for (const [key, p] of positions) {
        const cp = coinData[p.symbol]?.live?.currentPrice;
        if (!cp) continue;
        if ((p.side === 'LONG' && (cp >= p.tp || cp <= p.sl)) || (p.side === 'SHORT' && (cp <= p.tp || cp >= p.sl))) await closePosition(key, 'TP/SL', cp);
        else if (p.dca < botSettings.maxDca && (p.side === 'LONG' ? cp >= p.nextDca : cp <= p.nextDca)) await openPosition(p.symbol, p.side, cp, true);
    }
    setTimeout(monitorLoop, 1000);
}

app.post('/api/start', (req, res) => { botSettings.isRunning = true; addLog('🚀 BOT START'); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { botSettings.isRunning = false; addLog('⛔ BOT STOP'); res.json({ ok: true }); });
app.post('/api/closeall', async (req, res) => {
    const keys = Array.from(positions.keys());
    await Promise.all(keys.map(async (key) => {
        const p = positions.get(key);
        await exchange.createOrder(p.symbol, 'market', p.side === 'LONG' ? 'sell' : 'buy', p.qty, undefined, { reduceOnly: true, positionSide: p.side });
        positions.delete(key);
    }));
    addLog('⚠️ CLOSE ALL');
    res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
    let wallet = { totalWalletBalance: '0.00', availableBalance: '0.00', totalUnrealizedProfit: '0.00' };
    try { const acc = await binancePrivate('/fapi/v2/account'); wallet = { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) }; } catch {}
    res.json({ 
        botStatus: botSettings.isRunning ? 'RUNNING' : 'STOPPED', // Thêm trạng thái để HTML ẩn hiện
        botIp: await getPublicIP(), 
        wallet, 
        market: Object.entries(coinData).map(([s,v]) => ({ symbol: s, ...v.live })).slice(0, 30), 
        activePositions: Array.from(positions.values()), 
        status 
    });
});

app.listen(PORT, async () => {
    console.log(`BOT RUNNING ${PORT}`);
    await bootstrapData();
    initWS();
    fallbackAPI();
    autoTradeLoop();
    monitorLoop();
});

