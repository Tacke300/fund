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

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    timeout: 15000,
    headers: { 'X-MBX-APIKEY': API_KEY }
});

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

let botSettings = {
    isRunning: false,
    maxPositions: 3,
    invValue: "1%",
    minVol: 6.5,
    posTP: 1.2,
    posSL: 10.0,
    maxDCA: MAX_DCA_LEVEL
};

let status = {
    botLogs: [],
    blackList: {},
    permanentBlacklist: {},
    isReady: false
};

let botActivePositions = new Map();
let isProcessingDCA = new Set();
let timestampOffset = 0;

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

        const res = await binanceApi({
            method,
            url: `${endpoint}?${query}&signature=${signature}`
        });

        return res.data;
    } catch (e) {
        throw e;
    }
}

/* =========================
   PRICE MONITOR CORE
========================= */
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');

        for (let [key, b] of botActivePositions) {

            const realP = posRisk.find(p =>
                `${p.symbol}_${p.positionSide}` === key &&
                Math.abs(parseFloat(p.positionAmt)) > 0
            );

            /* =========================
               POSITION STILL OPEN
            ========================== */
            if (realP) {
                const markPrice = parseFloat(realP.markPrice);
                const qty = Math.abs(parseFloat(realP.positionAmt));

                b.pnl = parseFloat(realP.unRealizedProfit);

                const hitTP =
                    (b.side === 'LONG' && markPrice >= b.tp) ||
                    (b.side === 'SHORT' && markPrice <= b.tp);

                const hitSL =
                    (b.side === 'LONG' && markPrice <= b.sl) ||
                    (b.side === 'SHORT' && markPrice >= b.sl);

                // ❌ FIX: KHÔNG auto close theo timer nữa
                if (hitTP || hitSL) {
                    addBotLog(`CLOSE ${b.symbol} | ${hitTP ? 'TP' : 'SL'} | PNL: ${b.pnl}`);

                    await exchange.createOrder(
                        b.symbol,
                        'MARKET',
                        b.side === 'SHORT' ? 'BUY' : 'SELL',
                        qty,
                        undefined,
                        { positionSide: b.side }
                    );

                    botActivePositions.delete(key);
                }

            /* =========================
               POSITION CLOSED -> DCA LOGIC
            ========================== */
            } else {

                if (status.permanentBlacklist[b.symbol]) continue;
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', {
                    symbol: b.symbol,
                    limit: 10
                });

                let pnl = 0;
                for (const t of trades) {
                    pnl += parseFloat(t.realizedPnl || 0);
                }

                addBotLog(`CLOSED ${b.symbol} | PNL: ${pnl}`);

                botActivePositions.delete(key);

                /* =========================
                   DCA LOGIC FIXED
                ========================== */
                if (pnl < 0 && b.dcaCount < botSettings.maxDCA) {

                    isProcessingDCA.add(b.symbol);

                    await openPosition(b.symbol, {
                        ...b,
                        dcaCount: b.dcaCount + 1,
                        margin: b.firstMargin * 2,
                        totalLossAccumulated: (b.totalLossAccumulated || 0) + Math.abs(pnl)
                    });

                    setTimeout(() => isProcessingDCA.delete(b.symbol), 3000);

                } else if (pnl < 0 && b.dcaCount >= botSettings.maxDCA) {

                    addBotLog(`FINAL BLOCK ${b.symbol}`, 'error');
                    status.permanentBlacklist[b.symbol] = true;
                }
            }
        }

    } catch (e) {
        addBotLog(`MONITOR ERROR: ${e.message}`, 'error');
    }

    setTimeout(priceMonitor, 1000);
}

/* =========================
   OPEN POSITION FIXED
========================= */
async function openPosition(symbol, dcaData = null) {

    if (status.permanentBlacklist[symbol]) return;
    if (isProcessingDCA.has(symbol)) return;

    isProcessingDCA.add(symbol);

    try {
        const info = status.exchangeInfo?.[symbol];
        const acc = await binancePrivate('/fapi/v2/account');

        const availableUsdt = parseFloat(acc.availableBalance || 0);

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);

        let margin = dcaData
            ? dcaData.margin
            : (availableUsdt * 0.01);

        const qty = (margin * info.maxLeverage) / price;

        await exchange.setMarginMode('cross', symbol);
        await exchange.setLeverage(info.maxLeverage, symbol);

        const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';

        const order = await exchange.createOrder(
            symbol,
            'MARKET',
            side === 'SHORT' ? 'SELL' : 'BUY',
            qty.toFixed(info.quantityPrecision),
            undefined,
            { positionSide: side }
        );

        const pos = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const p = pos.find(x => x.positionSide === side);

        const entry = parseFloat(p.entryPrice);

        const tp = side === 'LONG'
            ? entry * (1 + botSettings.posTP / 100)
            : entry * (1 - botSettings.posTP / 100);

        const sl = side === 'LONG'
            ? entry * (1 - botSettings.posSL / 100)
            : entry * (1 + botSettings.posSL / 100);

        await syncTPSL(symbol, side, tp, sl);

        botActivePositions.set(`${symbol}_${side}`, {
            symbol,
            side,
            entryPrice: entry,
            tp,
            sl,
            dcaCount: dcaData?.dcaCount || 0,
            firstMargin: margin,
            pnl: 0
        });

        addBotLog(`OPEN ${symbol} ${side} | entry: ${entry}`);

    } catch (e) {
        status.permanentBlacklist[symbol] = true;
        addBotLog(`PERM BLOCK ${symbol} | ${e.message}`, 'error');
    }

    setTimeout(() => isProcessingDCA.delete(symbol), 2000);
}

/* =========================
   TP/SL SYNC FIXED
========================= */
async function syncTPSL(symbol, side, tpPrice, slPrice) {

    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });

        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', {
                symbol,
                orderId: o.orderId
            });
        }

        const closeSide = side === 'SHORT' ? 'BUY' : 'SELL';

        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', closeSide, undefined, undefined, {
            positionSide: side,
            stopPrice: tpPrice,
            closePosition: true
        });

        await exchange.createOrder(symbol, 'STOP_MARKET', closeSide, undefined, undefined, {
            positionSide: side,
            stopPrice: slPrice,
            closePosition: true
        });

    } catch (e) {
        addBotLog(`TPSL ERROR ${symbol}`, 'error');
    }
}

/* =========================
   SERVER
========================= */
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.listen(9001, () => {
    console.log("BOT RUNNING 9001");
});
