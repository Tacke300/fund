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
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 20000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { 
    botLogs: [], 
    exchangeInfo: null, 
    candidatesList: [], 
    isReady: false, 
    blackList: {}, 
    botClosedCount: 0, 
    botPnLClosed: 0 
};
let botActivePositions = new Map();
let timestampOffset = 0; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
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
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

async function syncTPSL(symbol, side, qty, entry, info) {
    try {
        // PHƯƠNG PHÁP: Hủy toàn bộ lệnh chờ của DUY NHẤT symbol này
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        addBotLog(`CLEAN OLD ORDERS: ${symbol} DONE`);
        
        // Nghỉ 1.2s để Binance cập nhật trạng thái hệ thống trước khi đặt lệnh mới
        await new Promise(r => setTimeout(r, 1200));

        const tpPrice = (entry * (side === 'SHORT' ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
        const slPrice = (entry * (side === 'SHORT' ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
        const sideClose = side === 'SHORT' ? 'buy' : 'sell';

        await Promise.all([
            exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true }),
            exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true })
        ]);
        
        addBotLog(`RE-SET TP/SL: ${symbol} (TP: ${tpPrice} - SL: ${slPrice})`, "success");
        return { tp: Number(tpPrice), sl: Number(slPrice) };
    } catch (e) { 
        addBotLog(`ERR SYNC ${symbol}: ${e.message}`, "error");
        return { tp: 0, sl: 0 }; 
    }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    try {
        const info = status.exchangeInfo[symbol];
        if (!info || info.maxLeverage < 20) return;

        const acc = await binancePrivate('/fapi/v2/account');
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        let targetUSDT = botSettings.invValue.toString().includes('%') 
            ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) 
            : parseFloat(botSettings.invValue);
        
        if (isDCA) {
            const current = botActivePositions.get(posKey);
            targetUSDT = (current.margin * info.maxLeverage) * 1.05; 
            current.isProcessing = true;
        }

        let qtyNum = Math.ceil((targetUSDT / price) / info.stepSize) * info.stepSize;
        while ((qtyNum * price) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const upPos = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            const sync = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, info);

            const qtyVal = (totalQty * avgEntry).toFixed(1);
            addBotLog(`${isDCA ? 'DCA' : 'OPEN'} ${symbol} - Qty: ${qtyVal}$ - Price: ${avgEntry}`, isDCA ? "warning" : "success");

            botActivePositions.set(posKey, { 
                symbol, side: 'SHORT', entryPrice: avgEntry, qty: totalQty, tp: sync.tp, sl: sync.sl, 
                margin: (totalQty * avgEntry / info.maxLeverage), 
                dcaCount: isDCA ? botActivePositions.get(posKey).dcaCount + 1 : 0, 
                leverage: info.maxLeverage, isProcessing: false, pnl: 0 
            });
        }
    } catch (e) { if (botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false; }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (realPos) {
                botPos.markPrice = realPos.markPrice;
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
            }
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) < (status.exchangeInfo[botPos.symbol].stepSize)) {
                status.botClosedCount++;
                status.botPnLClosed += (botPos.pnl || 0);
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                addBotLog(`CLOSE ${botPos.symbol} - PnL: ${(botPos.pnl || 0).toFixed(2)}$`, "success");
                botActivePositions.delete(key);
                continue;
            }
            const markPrice = parseFloat(realPos.markPrice);
            if ((botPos.tp > 0 && markPrice <= botPos.tp) || (botPos.sl > 0 && markPrice >= botPos.sl)) {
                if (!botPos.isProcessing) {
                    botPos.isProcessing = true;
                    await exchange.createOrder(botPos.symbol, 'market', 'buy', Math.abs(parseFloat(realPos.positionAmt)), undefined, { positionSide: 'SHORT' });
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || botPos.isProcessing) continue;
            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
        }
        if (botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const isBL = status.blackList[c.symbol] && (status.blackList[c.symbol] > now);
                return info && info.maxLeverage >= 20 && !isBL && !botActivePositions.has(`${c.symbol}_SHORT`) && [c.c1, c.c5, c.c15].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        await syncTime(); await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY READY", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3000);
setInterval(syncTime, 60000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status, 
            wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) } 
        });
    } catch (e) { res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
