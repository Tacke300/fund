import express from 'express';
import ccxt from 'ccxt';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

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

let botAlive = true;

let botSettings = {
    isRunning: false,
    capital: 5,
    volVolatility: 5,
    maxPos: 5,
    tp: 0.5,
    sl: 10,
    leverage: 20,
    dcaPercent: 10
};

let wallet = {
    totalWalletBalance: 0,
    availableBalance: 0,
    totalUnrealizedProfit: 0
};

let coinData = {};
let realtimePrice = {};
let exchangeInfo = {};
let marketsList = [];

let logs = [];

let positions = new Map();

function addLog(msg, symbol = '') {

    logs.unshift({
        time: new Date().toLocaleTimeString('vi-VN', {
            hour12: false
        }),
        symbol,
        msg
    });

    if (logs.length > 200) logs.pop();

    console.log(`[${symbol}] ${msg}`);
}

async function updateWallet() {

    try {

        const balance = await exchange.fetchBalance();

        wallet = {
            totalWalletBalance:
                parseFloat(balance.info?.totalMarginBalance || 0).toFixed(2),

            availableBalance:
                parseFloat(balance.info?.availableBalance || 0).toFixed(2),

            totalUnrealizedProfit:
                parseFloat(balance.info?.totalUnrealizedProfit || 0).toFixed(2)
        };

    } catch (e) {
        addLog(`WALLET ERROR ${e.message}`);
    }
}

async function updatePrices() {

    try {

        const tickers = await exchange.fetchTickers();

        for (const [symbol, ticker] of Object.entries(tickers)) {

            if (!symbol.includes('/USDT')) continue;

            realtimePrice[symbol.split('/')[0]] =
                ticker.last || 0;
        }

    } catch (e) {}

    setTimeout(updatePrices, 1000);
}

async function setCross(symbol) {

    try {

        await exchange.setMarginMode('cross', symbol);

        addLog(`CROSS MODE ENABLED`, symbol);

    } catch (e) {}
}

function buildSnapshot(c1, c5, c15) {

    return {
        c1: parseFloat(c1).toFixed(2),
        c5: parseFloat(c5).toFixed(2),
        c15: parseFloat(c15).toFixed(2)
    };
}

function buildPosition(symbol, side, price, qty, snap) {

    const tp =
        side === 'LONG'
            ? price * (1 + botSettings.tp / 100)
            : price * (1 - botSettings.tp / 100);

    const sl =
        side === 'LONG'
            ? price * (1 - botSettings.sl / 100)
            : price * (1 + botSettings.sl / 100);

    const nextDcaPrice =
        side === 'LONG'
            ? price * (1 - botSettings.dcaPercent / 100)
            : price * (1 + botSettings.dcaPercent / 100);

    return {

        symbol,
        side,

        lev: botSettings.leverage,

        margin: 'CROSS',

        qty,

        entryInitial: price,

        avg:
            side === 'LONG'
                ? price * 1.01
                : price * 0.99,

        currentPrice: price,

        tp,
        sl,

        pnl: 0,

        dcaLevel: 0,

        nextDcaPrice,

        snapshot: snap
    };
}

async function openPosition(symbol, side, price, snap) {

    if (!botSettings.isRunning) return;

    if (positions.size >= botSettings.maxPos) return;

    const key = `${symbol}-${side}`;

    if (positions.has(key)) return;

    const pair = `${symbol}/USDT`;

    try {

        await setCross(pair);

        const qty =
            parseFloat(
                (
                    (botSettings.capital * botSettings.leverage)
                    / price
                ).toFixed(3)
            );

        await exchange.createOrder(
            pair,
            'MARKET',
            side === 'LONG' ? 'BUY' : 'SELL',
            qty,
            undefined,
            {
                positionSide: side
            }
        );

        const pos =
            buildPosition(
                symbol,
                side,
                price,
                qty,
                snap
            );

        positions.set(key, pos);

        addLog(`════════════════════════════`, symbol);

        addLog(`OPEN ${side}`, symbol);

        addLog(`ENTRY ${price}`, symbol);

        addLog(`CURRENT ${price}`, symbol);

        addLog(`AVG ${pos.avg}`, symbol);

        addLog(`LEV ${botSettings.leverage}`, symbol);

        addLog(`MARGIN CROSS`, symbol);

        addLog(`QTY ${qty}`, symbol);

        addLog(`TP ${pos.tp}`, symbol);

        addLog(`SL ${pos.sl}`, symbol);

        addLog(`DCA ${pos.dcaLevel}`, symbol);

        addLog(`NEXT DCA ${pos.nextDcaPrice}`, symbol);

        addLog(`1M ${snap.c1}%`, symbol);

        addLog(`5M ${snap.c5}%`, symbol);

        addLog(`15M ${snap.c15}%`, symbol);

        addLog(`FULL ${JSON.stringify(pos)}`, symbol);

        addLog(`════════════════════════════`, symbol);

    } catch (e) {

        addLog(`OPEN ERROR ${e.message}`, symbol);
    }
}

function updatePositions() {

    for (const [key, pos] of positions.entries()) {

        const price = realtimePrice[pos.symbol];

        if (!price) continue;

        pos.currentPrice = price;

        pos.pnl =
            pos.side === 'LONG'
                ? (
                    (price - pos.entryInitial)
                    / pos.entryInitial
                ) * 100

                : (
                    (pos.entryInitial - price)
                    / pos.entryInitial
                ) * 100;

        const hitDca =

            (
                pos.side === 'LONG'
                &&
                price <= pos.nextDcaPrice
            )

            ||

            (
                pos.side === 'SHORT'
                &&
                price >= pos.nextDcaPrice
            );

        if (hitDca && pos.dcaLevel < 3) {

            pos.dcaLevel++;

            pos.avg =
                (pos.avg + price) / 2;

            pos.nextDcaPrice =
                pos.side === 'LONG'
                    ? price * (1 - botSettings.dcaPercent / 100)
                    : price * (1 + botSettings.dcaPercent / 100);

            addLog(
                `DCA ${pos.dcaLevel} @ ${price}`,
                pos.symbol
            );
        }

        positions.set(key, pos);
    }
}

async function scanCoin(pair) {

    try {

        const ohlcv =
            await exchange.fetchOHLCV(
                pair,
                '1m',
                undefined,
                20
            );

        if (!ohlcv || ohlcv.length < 20) return;

        const symbol = pair.split('/')[0];

        const price = ohlcv[19][4];

        const c1 =
            (
                (price - ohlcv[18][4])
                / ohlcv[18][4]
            ) * 100;

        const c5 =
            (
                (price - ohlcv[14][4])
                / ohlcv[14][4]
            ) * 100;

        const c15 =
            (
                (price - ohlcv[4][4])
                / ohlcv[4][4]
            ) * 100;

        const volatilityScore =
            Math.abs(c1)
            +
            Math.abs(c5)
            +
            Math.abs(c15);

        coinData[pair] = {

            symbol,

            c1,
            c5,
            c15,

            volatilityScore
        };

        if (
            botSettings.isRunning
            &&
            Math.abs(c15) >= botSettings.volVolatility
        ) {

            const snap =
                buildSnapshot(
                    c1,
                    c5,
                    c15
                );

            await openPosition(
                symbol,
                c15 >= 0 ? 'LONG' : 'SHORT',
                price,
                snap
            );
        }

    } catch (e) {}
}

async function marketLoop() {

    if (!botAlive) return;

    try {

        await Promise.all(
            marketsList.map(pair => scanCoin(pair))
        );

        updatePositions();

    } catch (e) {}

    setTimeout(marketLoop, 2000);
}

app.get('/api/status', (req, res) => {

    const top10 =
        Object.values(coinData)

            .sort(
                (a, b) =>
                    b.volatilityScore
                    -
                    a.volatilityScore
            )

            .slice(0, 10);

    res.json({

        botStatus:
            botSettings.isRunning
                ? 'RUNNING'
                : 'STOPPED',

        wallet,

        market: top10,

        activePositions:
            Array.from(positions.values()),

        logs
    });
});

app.post('/api/start', async (req, res) => {

    botSettings.isRunning = true;

    botAlive = true;

    addLog(`BOT STARTED`);

    marketLoop();

    res.json({
        ok: true
    });
});

app.post('/api/stop', async (req, res) => {

    botSettings.isRunning = false;

    botAlive = false;

    addLog(`BOT STOPPED`);

    res.json({
        ok: true
    });
});

app.post('/api/closeall', async (req, res) => {

    positions.clear();

    addLog(`ALL POSITIONS CLOSED`);

    res.json({
        ok: true
    });
});

app.post('/api/config', (req, res) => {

    botSettings = {
        ...botSettings,
        ...req.body
    };

    addLog(`CONFIG UPDATED`);

    res.json({
        ok: true
    });
});

app.listen(PORT, async () => {

    try {

        addLog(`LOADING MARKETS`);

        const markets =
            await exchange.loadMarkets();

        marketsList =
            Object.keys(markets)

                .filter(m =>

                    m.includes('/USDT')

                    &&

                    !m.includes('UP/')

                    &&

                    !m.includes('DOWN/')

                    &&

                    markets[m].active
                );

        for (const m of marketsList) {
            exchangeInfo[m] = true;
        }

        addLog(`TOTAL FUTURES ${marketsList.length}`);

        updateWallet();

        updatePrices();

        setInterval(updateWallet, 5000);

        marketLoop();

        console.log(`BOT READY http://localhost:${PORT}`);

    } catch (e) {

        console.log(e);
    }
});
