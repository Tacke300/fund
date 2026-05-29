import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// CẤU HÌNH HỆ THỐNG
// =========================================================================
const MARGIN_PROTECT_LIMIT = 60;
const MARGIN_RECOVER_LIMIT = 70;
const PORT = 1114;
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, capital: "1%", volVolatility: 6.5, maxPos: 3, maxDca: 2, dcaPercent: 10.0, tp: 1.2, sl: 10.0, longTp: 1.5, longSl: 8.0 };

if (fs.existsSync(CONFIG_FILE)) {
    try { botSettings = { ...botSettings, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) { console.error("Lỗi đọc config:", e.message); }
}

let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        let queryStr = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryStr).digest('hex');
        return (await binanceApi({ method, url: `${endpoint}?${queryStr}&signature=${signature}` })).data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const markP = parseFloat(realP.markPrice);
                const avgEntry = parseFloat(realP.entryPrice);
                b.avgEntryPrice = avgEntry;
                b.priceDev = ((markP - b.firstEntry) / b.firstEntry) * 100;
                
                // 1. Kiểm tra đóng hòa vốn có lãi (AVG + 1%)
                if (b.dcaCount > 0 && !isProcessingDCA.has(b.symbol)) {
                    const target = b.side === 'LONG' ? avgEntry * 1.01 : avgEntry * 0.99;
                    if ((b.side === 'LONG' && markP >= target) || (b.side === 'SHORT' && markP <= target)) {
                        isProcessingDCA.add(b.symbol);
                        addBotLog(`✅ Đóng lệnh ${b.symbol} tại ${markP} (AVG: ${avgEntry.toFixed(4)} + 1% lãi phí)`, "success");
                        await closePositionMarket(b.symbol, b.side, Math.abs(parseFloat(realP.positionAmt)));
                        continue;
                    }
                }
                // 2. Kiểm tra DCA dương
                if (b.dcaCount < botSettings.maxDca && !isProcessingDCA.has(b.symbol)) {
                    if ((b.side === 'LONG' && b.priceDev >= (b.dcaCount + 1) * botSettings.dcaPercent) || 
                        (b.side === 'SHORT' && b.priceDev <= -(b.dcaCount + 1) * botSettings.dcaPercent)) {
                        openPosition(b.symbol, { ...b }, b.side);
                    }
                }
            } else {
                if (!isProcessingDCA.has(b.symbol)) botActivePositions.delete(key);
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

async function closePositionMarket(symbol, side, qty) {
    try {
        const sideToClose = side === 'LONG' ? 'SELL' : 'BUY';
        await binancePrivate('/fapi/v1/order', 'POST', { symbol, side: sideToClose, positionSide: side, type: 'MARKET', quantity: qty });
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        botActivePositions.delete(`${symbol}_${side}`);
        status.blackList[symbol] = Date.now() + (15 * 60 * 1000);
    } catch(e) { addBotLog(`Lỗi đóng lệnh: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
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
            let capital = botSettings.capital.includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.capital) / 100) : parseFloat(botSettings.capital);
            qty = Math.ceil(((capital * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        }

        await exchange.setLeverage(info.maxLeverage, symbol);
        await exchange.createOrder(symbol, 'MARKET', (dcaData ? dcaData.side : triggerSide) === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: (dcaData ? dcaData.side : triggerSide) });
        
        await new Promise(r => setTimeout(r, 1000));
        const p = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(x => x.positionSide === (dcaData ? dcaData.side : triggerSide) && Math.abs(parseFloat(x.positionAmt)) > 0);
        
        const entry = parseFloat(p.entryPrice);
        botActivePositions.set(`${symbol}_${(dcaData ? dcaData.side : triggerSide)}`, { 
            symbol, side: (dcaData ? dcaData.side : triggerSide), firstEntry: dcaData ? dcaData.firstEntry : entry, 
            dcaCount: dcaData ? dcaData.dcaCount + 1 : 0, firstMargin: dcaData ? dcaData.firstMargin : (qty * currentPrice / info.maxLeverage) 
        });
        addBotLog(`📡 Đã vào lệnh ${symbol} ${dcaData ? 'DCA' : 'MỚI'} | Giá: ${entry}`);
    } catch (e) { addBotLog(`Lỗi: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2));
    res.json({ success: true });
});

APP.listen(PORT, () => console.log(`Bot running on port ${PORT}`));

// Khởi tạo
async function init() {
    const info = await binanceApi.get('/fapi/v1/exchangeInfo');
    const temp = {};
    info.data.symbols.forEach(s => {
        temp[s.symbol] = { quantityPrecision: s.quantityPrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: 20 };
    });
    status.exchangeInfo = temp; status.isReady = true; priceMonitor();
}
init();
