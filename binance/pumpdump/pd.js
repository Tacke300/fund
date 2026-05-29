import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 2;
const MARGIN_PROTECT_LIMIT = 60;
const MARGIN_RECOVER_LIMIT = 70;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        dualSidePosition: true,
        defaultMarginMode: 'cross',
        recvWindow: 60000,
        adjustForTimeDifference: true
    }
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
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
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
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

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`Unban Blacklist: ${symbol}`, "success");
        }
    }
}, 1000);

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);

    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) {}
            }
            botActivePositions.clear();
            isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');

        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);

            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);

                b.pnl = parseFloat(realP.unRealizedProfit);

                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else {
                    b.hitTime = null;
                }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;

                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 });
                const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED');

                let reasonOfClose = "MANUAL";
                if (closedById?.type === 'STOP_MARKET') reasonOfClose = "SL_MARKET";
                if (closedById?.type === 'TAKE_PROFIT_MARKET') reasonOfClose = "TP_MARKET";

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });

                let totalR = 0, totalV = 0;
                trades.forEach(t => {
                    totalR += parseFloat(t.realizedPnl);
                    totalV += parseFloat(t.price) * parseFloat(t.qty);
                });

                const fee = totalV * 0.0005;
                const netPnl = totalR - fee;

                botActivePositions.delete(key);

                if (netPnl < 0 && b.side === 'SHORT') {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, {
                            ...b,
                            dcaCount: jump,
                            margin: b.firstMargin * Math.pow(2, jump),
                            totalLossAccumulated: (b.totalLossAccumulated || 0) + Math.abs(netPnl)
                        });
                    } else {
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 10 });
                    }
                }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitor, 1000);
}

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);

    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';

    try {
        const info = status.exchangeInfo[symbol];

        const acc = await binancePrivate('/fapi/v2/account');
        const availableUsdt = parseFloat(acc.availableBalance || 0);

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

        let qty = 0;
        let margin = 0;

        if (isDCAorLong) {
            margin = dcaData.margin;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.invValue.includes('%')
                ? availableUsdt * parseFloat(botSettings.invValue) / 100
                : parseFloat(botSettings.invValue);

            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        }

        await exchange.setMarginMode('cross', symbol);
        await exchange.setLeverage(info.maxLeverage, symbol);

        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        if (order) {
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side);

            const entry = parseFloat(p.entryPrice);

            let tp = 0, sl = 0;

            if (side === 'LONG') {
                tp = entry * 1.15;
                sl = entry * 0.85;
            } else {
                tp = entry * 0.98;
                sl = entry * 1.05;
            }

            await syncTPSL(symbol, side, info, tp, sl);

            botActivePositions.set(`${symbol}_${side}`, {
                symbol,
                side,
                entryPrice: entry,
                tp,
                sl,
                dcaCount: dcaData?.dcaCount || 0,
                firstMargin: margin,
                currentQty: qty,
                pnl: 0
            });
        }
    } catch (e) {}
    setTimeout(() => isProcessingDCA.delete(symbol), 2000);
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }

        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side,
            stopPrice: tpPrice,
            closePosition: true
        });

        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side,
            stopPrice: slPrice,
            closePosition: true
        });

        return { tp: tpPrice, sl: slPrice };
    } catch (e) {
        return { tp: 0, sl: 0 };
    }
}

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.listen(9001);
