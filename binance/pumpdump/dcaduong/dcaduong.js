import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import ccxt from 'ccxt';
import WebSocket from 'ws';
import os from 'os';

import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } });

let botSettings = { isRunning: false, capital: '1%', volVolatility: 6.5, maxPos: 3, maxDca: 2, dcaPercent: 10, tp: 0.5, sl: 10 };
if (fs.existsSync(CONFIG_FILE)) { botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }

let timestampOffset = 0;
let botActivePositions = new Map();
let isProcessingDCA = new Set();
let coinData = {};
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: {}, isReady: false };

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        for (const iface of interfaces[devName]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const queryStr = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryStr).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${queryStr}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

function updatePriceLogic(symbol, price, now) {
    if (!coinData[symbol]) coinData[symbol] = { symbol, prices: [] };
    coinData[symbol].prices.push({ p: price, t: now });
    if (coinData[symbol].prices.length > 1200) coinData[symbol].prices.shift();
    const calculateChange = (pArr, min) => {
        let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0];
        return parseFloat(((pArr[pArr.length - 1].p - start.p) / start.p * 100).toFixed(2));
    };
    coinData[symbol].live = { c1: calculateChange(coinData[symbol].prices, 1), c5: calculateChange(coinData[symbol].prices, 5), c15: calculateChange(coinData[symbol].prices, 15), currentPrice: price };
}

async function openPosition(symbol, dcaData = null, triggerSide = 'LONG') {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = (await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data;
        const currentPrice = parseFloat(ticker.price);
        let qty, margin;
        if (dcaData) {
            margin = dcaData.firstMargin * Math.pow(2, dcaData.dcaCount + 1);
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            let capitalVal = botSettings.capital.includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.capital) / 100) : parseFloat(botSettings.capital);
            margin = Math.max(5.5, capitalVal);
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        }
        await exchange.setLeverage(info.maxLeverage, symbol);
        const finalSide = dcaData ? dcaData.side : triggerSide;
        await exchange.createOrder(symbol, 'MARKET', finalSide === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: finalSide });
        await new Promise(r => setTimeout(r, 1000));
        const p = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(x => x.positionSide === finalSide && Math.abs(parseFloat(x.positionAmt)) > 0);
        if (!p) return;
        const entry = parseFloat(p.entryPrice);
        botActivePositions.set(`${symbol}_${finalSide}`, { symbol, side: finalSide, firstEntry: dcaData ? dcaData.firstEntry : entry, dcaCount: dcaData ? dcaData.dcaCount + 1 : 0, firstMargin: dcaData ? dcaData.firstMargin : margin, avgEntryPrice: entry });
        addBotLog(`📌 OPEN ${symbol} | SIDE: ${finalSide} | ENTRY: ${entry} | QTY: ${qty} | LEV: ${info.maxLeverage}x | MARGIN: ${margin.toFixed(2)} | DCA: ${dcaData ? dcaData.dcaCount + 1 : 0}`);
    } catch (e) { addBotLog(`OPEN ERROR ${e.message}`, 'error'); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function closePositionMarket(symbol, side, qty) {
    try {
        await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: side === 'LONG' ? 'SELL' : 'BUY', positionSide: side, type: 'MARKET', quantity: qty });
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        botActivePositions.delete(`${symbol}_${side}`);
        status.blackList[symbol] = Date.now() + (15 * 60 * 1000);
        status.botClosedCount++;
    } catch (e) { addBotLog(`CLOSE ERROR ${e.message}`, 'error'); }
}

async function priceMonitor() {
    if (status.isReady) {
        try {
            const posRisk = await binancePrivate('/fapi/v2/positionRisk');
            for (let [key, b] of botActivePositions) {
                const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
                if (!realP) { botActivePositions.delete(key); continue; }
                const markP = parseFloat(realP.markPrice), avgEntry = parseFloat(realP.entryPrice), qty = Math.abs(parseFloat(realP.positionAmt));
                const priceDiff = ((markP - b.firstEntry) / b.firstEntry) * 100 * (b.side === 'LONG' ? 1 : -1);
                
                if (b.dcaCount > 0 && !isProcessingDCA.has(b.symbol)) {
                    const target = b.side === 'LONG' ? (avgEntry * 1.01) : (avgEntry * 0.99);
                    if ((b.side === 'LONG' && markP >= target) || (b.side === 'SHORT' && markP <= target)) {
                        isProcessingDCA.add(b.symbol);
                        const netPnl = ((b.side === 'LONG' ? (markP - avgEntry) : (avgEntry - markP)) * qty) - (qty * markP * 0.001);
                        status.botPnLClosed += netPnl;
                        addBotLog(`💲 AVG+1 CLOSE ${b.symbol} | PnL: ${netPnl.toFixed(2)}`);
                        await closePositionMarket(b.symbol, b.side, qty);
                        continue;
                    }
                }
                if (b.dcaCount < botSettings.maxDca && !isProcessingDCA.has(b.symbol) && priceDiff <= -botSettings.dcaPercent) {
                    addBotLog(`💵 DCA OPEN ${b.symbol} | LVL: ${b.dcaCount + 1}`);
                    await openPosition(b.symbol, { ...b }, b.side);
                }
            }
        } catch (e) { addBotLog(`MONITOR ERROR ${e.message}`, 'error'); }
    }
    setTimeout(priceMonitor, 1000);
}

APP.get('/api/status', async (req, res) => {
    res.json({ ip: getLocalIP(), isRunning: botSettings.isRunning, activePositions: Array.from(botActivePositions.values()), status });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2)); res.json({ success: true }); });
APP.post('/api/start', (req, res) => { botSettings.isRunning = true; addBotLog('🚀 BOT STARTED'); res.json({ success: true }); });
APP.post('/api/stop', (req, res) => { botSettings.isRunning = false; addBotLog('⛔ BOT STOPPED'); res.json({ success: true }); });
APP.post('/api/panic-close', async (req, res) => { /* Logic close all... */ res.json({ success: true }); });

async function init() {
    const info = await binanceApi.get('/fapi/v1/exchangeInfo');
    status.exchangeInfo = info.data.symbols.reduce((acc, s) => {
        const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
        acc[s.symbol] = { quantityPrecision: s.quantityPrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: 20 };
        return acc;
    }, {});
    status.isReady = true;
    priceMonitor();
    APP.listen(PORT);
}
init();
