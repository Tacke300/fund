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
const RECV_WINDOW = 50000;

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: RECV_WINDOW } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };

let status = { 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [], 
    isReady: false, 
    blackList: {}, 
    botClosedCount: 0, 
    botPnLClosed: 0.00 
};

let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

function addBotLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() { 
    try { 
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); 
        timestampOffset = res.data.serverTime - Date.now(); 
    } catch (e) {} 
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: RECV_WINDOW }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

async function syncTPSL(symbol, side, entry, info) {
    const isShort = (side === 'SHORT');
    const tpPrice = Number((entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + 10 / 100))).toFixed(info.pricePrecision));
    const slPrice = Number((entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - 10 / 100))).toFixed(info.pricePrecision));
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 1000));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: 'true' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: slPrice, closePosition: 'true' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: tpPrice, sl: slPrice }; }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.size >= botSettings.maxPositions || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        let currentPos = botActivePositions.get(posKey);
        
        const acc = await binancePrivate('/fapi/v2/account');
        let margin = isDCA ? (currentPos.firstMargin * 1.03) : (botSettings.invValue.toString().includes('%') ? 
            (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));

        let qtyNum = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 6.5) qtyNum = (6.5 / currentPrice);

        await exchange.setLeverage(info.maxLeverage, symbol);
        addBotLog(`🚀 [${symbol}] Đang ${isDCA ? 'DCA lần ' + (currentPos.dcaCount + 1) : 'mở lệnh SHORT'}...`);
        
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            if (upPos && Math.abs(parseFloat(upPos.positionAmt)) > 0) {
                const entry = parseFloat(upPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', entry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: entry, 
                    qty: Math.abs(parseFloat(upPos.positionAmt)), 
                    margin: (Math.abs(parseFloat(upPos.positionAmt)) * entry) / info.maxLeverage,
                    leverage: info.maxLeverage,
                    tp: sync.tp, sl: sync.sl, 
                    firstMargin: isDCA ? currentPos.firstMargin : margin, 
                    dcaCount: isDCA ? currentPos.dcaCount + 1 : 0 
                });
                addBotLog(`✅ [${symbol}] ${isDCA ? 'DCA' : 'VÀO LỆNH'} XONG. TP: ${sync.tp}`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi [${symbol}]: ${e.message}`); }
    finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.botClosedCount++;
                status.botPnLClosed += (botPos.pnl || 0);
                status.blackList[botPos.symbol] = 600; 
                botActivePositions.delete(key);
                addBotLog(`💰 [${botPos.symbol}] Đã chốt vị thế. PnL: ${(botPos.pnl || 0).toFixed(2)}$`);
                continue;
            }
            botPos.markPrice = parseFloat(realPos.markPrice);
            botPos.pnl = parseFloat(realPos.unRealizedProfit);
        }
        for (let s in status.blackList) {
            if (status.blackList[s] > 0) status.blackList[s]--;
            else delete status.blackList[s];
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    for (let [key, botPos] of botActivePositions) {
        const dev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
        if (dev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
    }
    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const keo = status.candidatesList.find(c => {
            const info = status.exchangeInfo[c.symbol];
            return info && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && Math.abs(c.c1) >= botSettings.minVol;
        });
        if (keo) await openPosition(keo.symbol, false);
    }
}

async function init() {
    await syncTime();
    try {
        await exchange.loadMarkets();
        const [infoRes, brkRes] = await Promise.all([binanceApi.get('/fapi/v1/exchangeInfo'), binancePrivate('/fapi/v1/leverageBracket')]);
        infoRes.data.symbols.forEach(s => {
            const brk = brkRes.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.isReady = true; 
        addBotLog("👿 LUFFY BOT ONLINE & READY");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

APP.get('/api/status', async (req, res) => {
    let wallet = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        wallet = { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2),
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
        };
    } catch (e) {}
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    addBotLog(`⚙️ Cấu hình đã thay đổi: isRunning = ${botSettings.isRunning}`);
    res.json({ success: true }); 
});

APP.listen(9001);
init(); 
setInterval(mainLoop, 3000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);
