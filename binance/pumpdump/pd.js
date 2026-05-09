import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 10.0, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

// --- LOGIC XỬ LÝ TP/SL MỚI ---
async function handleTPSL(action, symbol) {
    const posKey = `${symbol}_SHORT`;
    const botPos = botActivePositions.get(posKey);
    const info = status.exchangeInfo[symbol];
    if (!botPos || !info) return;

    try {
        // 1. Xóa lệnh cũ (Áp dụng cho action: delete, setup, reset)
        if (['delete', 'setup', 'reset'].includes(action)) {
            const openOrders = await exchange.fetchOpenOrders(symbol);
            for (const o of openOrders) {
                if (o.info.positionSide === 'SHORT' && (o.type === 'take_profit_market' || o.type === 'stop_market')) {
                    await exchange.cancelOrder(o.id, symbol, { positionSide: 'SHORT' });
                }
            }
            addBotLog(`🗑️ [${symbol}] Đã dọn sạch lệnh TP/SL cũ`);
        }

        // 2. Cài lệnh mới (Áp dụng cho setup, reset)
        if (['setup', 'reset'].includes(action)) {
            // Quy tắc nhảy bước 10% -> 15%
            botPos.tpslStep = (botPos.tpslStep === 10) ? 15 : 10;
            const tpP = botPos.tpslStep;
            const slP = botSettings.posSL;

            const entry = botPos.entryPrice;
            const tpPrice = (entry * (1 - tpP / 100)).toFixed(info.pricePrecision);
            const slPrice = (entry * (1 + slP / 100)).toFixed(info.pricePrecision);

            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'BUY', undefined, undefined, { 
                positionSide: 'SHORT', stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE' 
            });
            await exchange.createOrder(symbol, 'STOP_MARKET', 'BUY', undefined, undefined, { 
                positionSide: 'SHORT', stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE' 
            });

            botPos.tp = parseFloat(tpPrice);
            botPos.sl = parseFloat(slPrice);
            addBotLog(`🎯 [${symbol}] Đã cài TP/SL mới: ${tpP}% (Giá: ${tpPrice})`, "success");
        }
    } catch (e) { addBotLog(`🚨 Lỗi TPSL [${symbol}]: ${e.message}`, "error"); }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0;
        let cp = botActivePositions.get(posKey);

        if (isDCA) {
            marginToUse = cp.firstMargin;
            cp.isProcessing = true;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        await exchange.setLeverage(info.maxLeverage, symbol);
        
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: parseFloat(realP.entryPrice), 
                    qty: Math.abs(parseFloat(realP.positionAmt)), 
                    margin: (Math.abs(parseFloat(realP.positionAmt)) * parseFloat(realP.entryPrice)) / info.maxLeverage,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, 
                    firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    tpslStep: 15, // Khởi tạo để nhấn reset lần đầu ra 10%
                    isProcessing: false 
                });
                await handleTPSL('reset', symbol); // Tự động đặt TP/SL sau khi mở/DCA
            }
        }
    } catch (e) { addBotLog(`🚨 Lỗi Open [${symbol}]: ${e.message}`, "error"); } finally { openingSymbols.delete(symbol); }
}

// --- LOOPS & INIT ---
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();
        posRisk.forEach(p => { if (Math.abs(parseFloat(p.positionAmt)) > 0) exchangeKeys.add(`${p.symbol}_${p.positionSide}`); });

        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] Đã đóng vị thế.`);
                botActivePositions.delete(key);
            } else {
                const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
                botPos.markPrice = parseFloat(p.markPrice);
                botPos.pnl = parseFloat(p.unRealizedProfit);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brkRes.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        priceMonitorLoop();
        addBotLog("🚀 Bot đã sẵn sàng!");
    } catch (e) { setTimeout(init, 5000); }
}

init();

// --- API ROUTES ---
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            wallet: { balance: parseFloat(acc.totalWalletBalance).toFixed(2), pnl: parseFloat(acc.totalUnrealizedProfit).toFixed(2) },
            logs: status.botLogs
        });
    } catch (e) { res.json({ error: true }); }
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

APP.post('/api/test', async (req, res) => {
    const { action, symbol } = req.body;
    const s = symbol.toUpperCase();
    if (action === 'open') await openPosition(s);
    if (action === 'close') {
        const pos = botActivePositions.get(`${s}_SHORT`);
        if (pos) await exchange.createOrder(s, 'MARKET', 'BUY', pos.qty.toFixed(status.exchangeInfo[s].quantityPrecision), undefined, { positionSide: 'SHORT' });
    }
    if (['delete', 'setup', 'reset'].includes(action)) await handleTPSL(action, s);
    res.json({ success: true });
});

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001, () => console.log("Server chạy tại http://localhost:9001"));
