import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 2;

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
        hedgeMode: true,
        recvWindow: 60000,
        adjustForTimeDifference: true
    }
});

let timestampOffset = 0;

const botSettings = {
    isRunning: true,
    maxPositions: 3,
    invValue: '1%',
    posTP: 1.2,
    posSL: 10,
    maxDCA: MAX_DCA_LEVEL
};

const status = {
    exchangeInfo: {},
    permanentBlacklist: {},
    botLogs: [],
    isReady: false
};

const botActivePositions = new Map();
const isProcessing = new Set();

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });

    status.botLogs.unshift({
        time,
        msg,
        type
    });

    if (status.botLogs.length > 200) {
        status.botLogs.pop();
    }

    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {

    try {

        const timestamp = Date.now() + timestampOffset;

        const query = new URLSearchParams({
            ...data,
            timestamp,
            recvWindow: 60000
        }).toString();

        const signature = crypto
            .createHmac('sha256', SECRET_KEY)
            .update(query)
            .digest('hex');

        const response = await binanceApi({
            method,
            url: `${endpoint}?${query}&signature=${signature}`
        });

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

async function loadExchangeInfo() {

    try {

        const exchangeInfo = await binancePrivate('/fapi/v1/exchangeInfo');

        for (const s of exchangeInfo.symbols) {

            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');

            status.exchangeInfo[s.symbol] = {
                symbol: s.symbol,
                stepSize: parseFloat(lotFilter.stepSize),
                quantityPrecision: s.quantityPrecision,
                maxLeverage: 50
            };
        }

        status.isReady = true;

        addBotLog('EXCHANGE INFO LOADED');

    } catch (e) {

        addBotLog(`LOAD INFO ERROR ${e.message}`, 'error');
    }
}

async function forceCross(symbol) {

    try {

        await binancePrivate(
            '/fapi/v1/marginType',
            'POST',
            {
                symbol,
                marginType: 'CROSSED'
            }
        );

    } catch (e) {}
}

async function syncTPSL(symbol, side, tpPrice, slPrice) {

    try {

        const orders = await binancePrivate(
            '/fapi/v1/openOrders',
            'GET',
            { symbol }
        );

        for (const o of orders.filter(o => o.positionSide === side)) {

            await binancePrivate(
                '/fapi/v1/order',
                'DELETE',
                {
                    symbol,
                    orderId: o.orderId
                }
            );
        }

        const closeSide = side === 'SHORT' ? 'BUY' : 'SELL';

        await exchange.createOrder(
            symbol,
            'TAKE_PROFIT_MARKET',
            closeSide,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice: tpPrice,
                closePosition: true,
                workingType: 'MARK_PRICE'
            }
        );

        await exchange.createOrder(
            symbol,
            'STOP_MARKET',
            closeSide,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice: slPrice,
                closePosition: true,
                workingType: 'MARK_PRICE'
            }
        );

        return true;

    } catch (e) {

        addBotLog(`TPSL ERROR ${symbol} ${e.message}`, 'error');

        return false;
    }
}

async function openPosition(symbol, dcaData = null) {

    if (status.permanentBlacklist[symbol]) return;

    if (isProcessing.has(symbol)) return;

    isProcessing.add(symbol);

    try {

        const info = status.exchangeInfo[symbol];

        if (!info) {
            status.permanentBlacklist[symbol] = true;
            return;
        }

        const acc = await binancePrivate('/fapi/v2/account');

        const availableUsdt = parseFloat(acc.availableBalance || 0);

        const mark = await binancePrivate(
            '/fapi/v1/premiumIndex',
            'GET',
            { symbol }
        );

        const markPrice = parseFloat(mark.markPrice);

        let margin = 0;

        if (dcaData) {

            margin = dcaData.margin;

        } else {

            margin = botSettings.invValue.includes('%')
                ? availableUsdt * parseFloat(botSettings.invValue) / 100
                : parseFloat(botSettings.invValue);
        }

        const rawQty =
            (margin * info.maxLeverage) / markPrice;

        const qty =
            Math.floor(rawQty / info.stepSize) * info.stepSize;

        if (qty <= 0) {
            throw new Error('INVALID_QTY');
        }

        await forceCross(symbol);

        await exchange.setLeverage(
            info.maxLeverage,
            symbol
        );

        const side =
            dcaData?.isFinalLong
                ? 'LONG'
                : 'SHORT';

        const order = await exchange.createOrder(
            symbol,
            'MARKET',
            side === 'SHORT' ? 'SELL' : 'BUY',
            qty.toFixed(info.quantityPrecision),
            undefined,
            {
                positionSide: side
            }
        );

        if (!order) {
            throw new Error('ORDER_FAILED');
        }

        await new Promise(r => setTimeout(r, 500));

        const posRisk = await binancePrivate(
            '/fapi/v2/positionRisk',
            'GET',
            { symbol }
        );

        const pos = posRisk.find(p =>
            p.positionSide === side &&
            Math.abs(parseFloat(p.positionAmt)) > 0
        );

        if (!pos) {
            throw new Error('POSITION_NOT_FOUND');
        }

        const entry = parseFloat(pos.entryPrice);

        let tp = 0;
        let sl = 0;

        if (side === 'LONG') {

            tp = entry * (1 + botSettings.posTP / 100);
            sl = entry * (1 - botSettings.posSL / 100);

        } else {

            tp = entry * (1 - botSettings.posTP / 100);
            sl = entry * (1 + botSettings.posSL / 100);
        }

        const synced = await syncTPSL(
            symbol,
            side,
            tp,
            sl
        );

        if (!synced) {
            throw new Error('TPSL_FAILED');
        }

        botActivePositions.set(
            `${symbol}_${side}`,
            {
                symbol,
                side,
                entryPrice: entry,
                tp,
                sl,
                dcaCount: dcaData?.dcaCount || 0,
                firstMargin: margin,
                qty,
                pnl: 0,
                markPrice
            }
        );

        addBotLog(
            `🔔OPEN ${symbol} ${side} CROSS lev:${info.maxLeverage} entry:${entry} tp:${tp} sl:${sl} dca:${dcaData?.dcaCount || 0}`
        );

    } catch (e) {

        status.permanentBlacklist[symbol] = true;

        addBotLog(
            `⛔PERM BLOCK ${symbol} ${e.message}`,
            'error'
        );
    }

    setTimeout(() => {
        isProcessing.delete(symbol);
    }, 3000);
}

async function priceMonitor() {

    if (!status.isReady) {
        return setTimeout(priceMonitor, 1000);
    }

    if (!botSettings.isRunning) {
        return setTimeout(priceMonitor, 1000);
    }

    try {

        const posRisk = await binancePrivate(
            '/fapi/v2/positionRisk'
        );

        for (const [key, b] of botActivePositions) {

            const realP = posRisk.find(p =>
                `${p.symbol}_${p.positionSide}` === key &&
                Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (realP) {

                b.pnl = parseFloat(realP.unRealizedProfit);
                b.markPrice = parseFloat(realP.markPrice);

            } else {

                if (status.permanentBlacklist[b.symbol]) {
                    continue;
                }

                if (isProcessing.has(b.symbol)) {
                    continue;
                }

                isProcessing.add(b.symbol);

                try {

                    const trades = await binancePrivate(
                        '/fapi/v1/userTrades',
                        'GET',
                        {
                            symbol: b.symbol,
                            limit: 20
                        }
                    );

                    let pnl = 0;

                    for (const t of trades) {
                        pnl += parseFloat(
                            t.realizedPnl || 0
                        );
                    }

                    botActivePositions.delete(key);

                    addBotLog(
                        `💲CLOSE ${b.symbol} pnl:${pnl.toFixed(4)} dca:${b.dcaCount}`
                    );

                    if (
                        pnl < 0 &&
                        b.dcaCount < botSettings.maxDCA
                    ) {

                        addBotLog(
                            `📌DCA ${b.symbol} -> ${b.dcaCount + 1}`
                        );

                        await openPosition(
                            b.symbol,
                            {
                                ...b,
                                dcaCount: b.dcaCount + 1,
                                margin: b.firstMargin * 2
                            }
                        );

                    } else if (
                        pnl < 0 &&
                        b.dcaCount >= botSettings.maxDCA
                    ) {

                        status.permanentBlacklist[b.symbol] = true;

                        addBotLog(
                            `⛔FINAL BLOCK ${b.symbol}`
                        );
                    }

                } catch (e) {

                    addBotLog(
                        `MONITOR CLOSE ERROR ${b.symbol} ${e.message}`,
                        'error'
                    );
                }

                setTimeout(() => {
                    isProcessing.delete(b.symbol);
                }, 3000);
            }
        }

    } catch (e) {

        addBotLog(
            `PRICE MONITOR ERROR ${e.message}`,
            'error'
        );
    }

    setTimeout(priceMonitor, 1000);
}

const APP = express();

APP.use(express.json());
APP.use(express.static(__dirname));

APP.listen(1113, async () => {

    console.log('BOT RUNNING 1113');

    await loadExchangeInfo();

    priceMonitor();
});
