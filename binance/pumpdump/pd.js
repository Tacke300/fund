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

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
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

async function setTPSL(symbol, side, qty, entry, dcaCount, info) {
    const tp = (entry * (1 - botSettings.posTP / 100)).toFixed(info.pricePrecision);
    let sl = (dcaCount === 4) ? (entry * (1 + botSettings.dcaStep / 100)).toFixed(info.pricePrecision) : (entry * (1 + botSettings.posSL / 100)).toFixed(info.pricePrecision);
    const sideClose = side === 'SHORT' ? 'buy' : 'sell';
    await exchange.cancelAllOrders(symbol);
    await Promise.all([
        exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tp, closePosition: true }),
        exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: sl, closePosition: true })
    ]);
    return { tp, sl };
}

async function openPosition(symbol, isDCA = false, candidateData = null) {
    const posKey = `${symbol}_SHORT`;
    let currentPos = botActivePositions.get(posKey);
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
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posRisk.find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(realPos.entryPrice);
            const totalQty = Math.abs(parseFloat(realPos.positionAmt));
            const dcaCount = isDCA ? currentPos.dcaCount + 1 : 0;
            const { tp, sl } = await setTPSL(symbol, 'SHORT', totalQty, avgEntry, dcaCount, info);
            botActivePositions.set(posKey, { symbol, side: 'SHORT', entryPrice: avgEntry, qty: totalQty, tp, sl, margin, dcaCount, baseInv: baseMargin, lastUpdate: Date.now(), isProcessing: false });
            addBotLog(isDCA ? `⚠️ DCA LẦN ${dcaCount} | ${symbol} | Entry mới: ${avgEntry} | TP: ${tp} | SL: ${sl}` : `🚀 MỞ SHORT | ${symbol} (1m:${candidateData.c1}%) | Entry: ${avgEntry} | TP: ${tp}`, isDCA ? "warning" : "success");
        }
    } catch (e) { if (isDCA) currentPos.isProcessing = false; addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const openOrders = await binancePrivate('/fapi/v1/openOrders');
        const now = Date.now();
        const marginRatio = (parseFloat(acc.totalInitialMargin) / parseFloat(acc.totalWalletBalance)) * 100;
        status.canOpenNew = marginRatio < 45;

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || parseFloat(realPos.positionAmt) === 0) {
                await exchange.cancelAllOrders(botPos.symbol);
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                botActivePositions.delete(key);
                addBotLog(`✅ ĐÓNG LỆNH | ${botPos.symbol}`, "info");
                continue;
            }

            // Kiểm tra thiếu TP/SL mỗi 60 giây để tránh spam log
            if (now - botPos.lastUpdate > 60000) {
                const orders = openOrders.filter(o => o.symbol === botPos.symbol && o.positionSide === botPos.side);
                if (orders.length < 2) {
                    botPos.isProcessing = true;
                    await setTPSL(botPos.symbol, botPos.side, Math.abs(parseFloat(realPos.positionAmt)), parseFloat(realPos.entryPrice), botPos.dcaCount, status.exchangeInfo[botPos.symbol]);
                    botPos.isProcessing = false;
                    addBotLog(`🛠️ Cập nhật lại TP/SL cho ${botPos.symbol}`, "warning");
                }
                botPos.lastUpdate = now;
            }

            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (botPos.side === 'SHORT' && priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
        }

        if (botSettings.isRunning && status.canOpenNew && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const isBlack = status.blackList[c.symbol] && now < status.blackList[c.symbol];
                const satisfiesVol = Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol || Math.abs(c.c15) >= botSettings.minVol;
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !isBlack && satisfiesVol;
            });
            if (keo) await openPosition(keo.symbol, false, keo);
        }
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
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY v19.9 - CLEAN LOG - READY", "success");
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

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
