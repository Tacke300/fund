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
const exchange = new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, options: { defaultType: 'future', dualSidePosition: true } });

let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, 
    posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4     
};

let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, canOpenNew: true };
let botActivePositions = new Map(); 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) { throw new Error(error.response?.data?.msg || error.message); }
}

function calculateMargin(inputValue, availableBalance) {
    const valStr = String(inputValue).trim();
    if (valStr.endsWith('%')) return (availableBalance * parseFloat(valStr.replace('%', ''))) / 100;
    return parseFloat(valStr);
}

async function openHedgeLong(symbol, info, oldBaseMargin) {
    try {
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        const lev = info.maxLeverage;
        let multiplier = (lev < 50) ? 50 : (lev < 75 ? 100 : 150);
        const newMargin = oldBaseMargin * multiplier;
        let qty = ((newMargin * lev / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        const order = await exchange.createOrder(symbol, 'market', 'buy', qty, undefined, { positionSide: 'LONG' });
        if (order) {
            const entry = order.price || price;
            const tp = (entry * (1 + (botSettings.dcaStep * 2) / 100)).toFixed(info.pricePrecision);
            const sl = (entry * (1 - botSettings.dcaStep / 100)).toFixed(info.pricePrecision);

            await exchange.cancelAllOrders(symbol);
            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'sell', qty, undefined, { positionSide: 'LONG', stopPrice: tp, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', 'sell', qty, undefined, { positionSide: 'LONG', stopPrice: sl, closePosition: true })
            ]);

            botActivePositions.set(`${symbol}_LONG`, { symbol, side: 'LONG', entryPrice: entry, qty, tp, sl, margin: newMargin, dcaCount: 99, lastUpdate: Date.now(), isProcessing: false });
            addBotLog(`🛡️ PHÒNG HỘ | ${symbol} | Margin: ${newMargin.toFixed(2)}$ | Entry: ${entry}`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi Hedge: ${e.message}`, "error"); }
}

async function openPosition(symbol, isDCA = false, candidateData = null) {
    const posKey = `${symbol}_SHORT`;
    let currentPos = botActivePositions.get(posKey);

    // KHÓA LỆNH: Nếu đang xử lý thì không cho phép vào lại
    if (isDCA && currentPos?.isProcessing) return;
    if (isDCA) currentPos.isProcessing = true;

    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        let baseMargin = isDCA ? currentPos.baseInv : calculateMargin(botSettings.invValue, parseFloat(acc.availableBalance));
        let margin = isDCA ? (currentPos.margin * 1.5) : baseMargin;
        let qty = ((margin * info.maxLeverage / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty, undefined, { positionSide: 'SHORT' });

        if (order) {
            const entry = order.price || price;
            const dcaCount = isDCA ? currentPos.dcaCount + 1 : 0;
            const tp = (entry * (1 - botSettings.posTP / 100)).toFixed(info.pricePrecision);
            let sl = (dcaCount === 4) ? (entry * (1 + botSettings.dcaStep / 100)).toFixed(info.pricePrecision) : (entry * (1 + botSettings.posSL / 100)).toFixed(info.pricePrecision);

            await exchange.cancelAllOrders(symbol);
            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'buy', qty, undefined, { positionSide: 'SHORT', stopPrice: tp, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', 'buy', qty, undefined, { positionSide: 'SHORT', stopPrice: sl, closePosition: true })
            ]);

            botActivePositions.set(posKey, { 
                symbol, side: 'SHORT', entryPrice: entry, qty, tp, sl, 
                margin, dcaCount, baseInv: baseMargin, lastUpdate: Date.now(), isProcessing: false 
            });

            if (isDCA) {
                addBotLog(`⚠️ DCA LẦN ${dcaCount} | ${symbol} | Giá: ${price} | Entry mới: ${entry}`, "warning");
            } else {
                addBotLog(`🚀 MỞ SHORT | ${symbol} (1m:${candidateData.c1} 5m:${candidateData.c5} 15m:${candidateData.c15}) | Margin: ${margin.toFixed(2)}$ | Entry: ${entry}`, "success");
            }
        }
    } catch (e) {
        if (isDCA) currentPos.isProcessing = false;
        addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error");
    }
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const openOrders = await binancePrivate('/fapi/v1/openOrders');
        const now = Date.now();

        const totalUsedMargin = parseFloat(acc.totalInitialMargin);
        const totalWallet = parseFloat(acc.totalWalletBalance);
        const marginRatio = (totalUsedMargin / totalWallet) * 100;

        // Logic Margin Safety 40/50
        if (marginRatio > 50) status.canOpenNew = false;
        else if (marginRatio < 40) status.canOpenNew = true;

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; // Bỏ qua nếu đang xử lý lệnh

            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            if (!realPos || parseFloat(realPos.positionAmt) === 0) {
                addBotLog(`✅ ĐÓNG LỆNH | ${botPos.symbol}`, "info");
                if (botPos.side === 'SHORT' && botPos.dcaCount === 4) {
                    await openHedgeLong(botPos.symbol, status.exchangeInfo[botPos.symbol], botPos.baseInv);
                }
                await exchange.cancelAllOrders(botPos.symbol);
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                botActivePositions.delete(key);
                continue;
            }

            // Kiểm tra TP/SL sau 15s
            if (now - botPos.lastUpdate > 15000) {
                const orders = openOrders.filter(o => o.symbol === botPos.symbol && o.positionSide === botPos.side);
                if (orders.length < 2) {
                    addBotLog(`🛠️ Cài lại TP/SL cho ${botPos.symbol}`, "warning");
                    botPos.isProcessing = true;
                    await exchange.cancelAllOrders(botPos.symbol);
                    const sideClose = botPos.side === 'SHORT' ? 'buy' : 'sell';
                    await Promise.all([
                        exchange.createOrder(botPos.symbol, 'TAKE_PROFIT_MARKET', sideClose, botPos.qty, undefined, { positionSide: botPos.side, stopPrice: botPos.tp, closePosition: true }),
                        exchange.createOrder(botPos.symbol, 'STOP_MARKET', sideClose, botPos.qty, undefined, { positionSide: botPos.side, stopPrice: botPos.sl, closePosition: true })
                    ]).finally(() => botPos.isProcessing = false);
                }
                botPos.lastUpdate = now;
            }

            // Logic DCA 10% Giá
            const markPrice = parseFloat(realPos.markPrice);
            const entryPrice = parseFloat(realPos.entryPrice);
            const priceDev = ((markPrice - entryPrice) / entryPrice) * 100;

            if (botPos.side === 'SHORT' && priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) {
                await openPosition(botPos.symbol, true);
            }
        }

        if (botSettings.isRunning && status.canOpenNew && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const isBlack = status.blackList[c.symbol] && now < status.blackList[c.symbol];
                const satisfiesVol = Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol || Math.abs(c.c15) >= botSettings.minVol;
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !isBlack && satisfiesVol;
            });
            if (keo) await openPosition(keo.symbol, false, keo);
        }
        Object.keys(status.blackList).forEach(sym => { if (now > status.blackList[sym]) delete status.blackList[sym]; });
    } catch (e) {}
}

async function init() {
    try {
        await exchange.setPositionMode(true).catch(() => {});
        const [infoRes, brkRes] = await Promise.all([binanceApi.get('/fapi/v1/exchangeInfo'), binancePrivate('/fapi/v1/leverageBracket')]);
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY v19.7 - FIXED DCA SPAM - READY", "success");
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3500);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
