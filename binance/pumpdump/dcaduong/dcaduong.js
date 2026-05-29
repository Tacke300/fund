import express from 'express';
import ccxt from 'ccxt';
import WebSocket from 'ws';
import fetch from 'node-fetch';
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

let botSettings = {
    isRunning: false,
    capital: 5,
    volVolatility: 6.5,
    maxPos: 5,
    tp: 0.5,
    sl: 10,
    leverage: 20,
    dcaPercent: 10
};

let walletCache = {
    totalWalletBalance: '0.00',
    availableBalance: '0.00',
    totalUnrealizedProfit: '0.00'
};

let status = {
    botLogs: []
};

let realtimePrice = {};
let coinData = {};
let priceHistory = {};

let positions = new Map();

let stats = {
    totalClosed: 0,
    totalDca: 0,
    totalPnl: 0
};

function addLog(msg, symbol = '') {

    const log = {
        time: new Date().toLocaleTimeString('vi-VN', {
            hour12: false
        }),
        symbol,
        msg
    };

    status.botLogs.unshift(log);

    if (status.botLogs.length > 200) {
        status.botLogs.pop();
    }

    console.log(
        `[${log.time}] ${symbol} ${msg}`
    );
}

async function preloadWallet() {

    try {

        const acc =
            await exchange.fetchBalance();

        walletCache = {

            totalWalletBalance:
                parseFloat(
                    acc.info?.totalMarginBalance || 0
                ).toFixed(2),

            availableBalance:
                parseFloat(
                    acc.info?.availableBalance || 0
                ).toFixed(2),

            totalUnrealizedProfit:
                parseFloat(
                    acc.info?.totalUnrealizedProfit || 0
                ).toFixed(2)
        };

    } catch (e) {

        addLog(
            `⛔ WALLET ${e.message}`
        );
    }
}

async function setCrossMargin(pair) {

    try {

        await exchange.setMarginMode(
            'cross',
            pair
        );

        addLog(
            `✅ CROSS ${pair}`
        );

    } catch (e) {}
}

async function openPosition(
    symbol,
    side,
    price,
    snap
) {

    if (!botSettings.isRunning) return;

    if (positions.size >= botSettings.maxPos) return;

    const key =
        `${symbol}_${side}`;

    if (positions.has(key)) return;

    try {

        const pair =
            `${symbol}/USDT`;

        await setCrossMargin(pair);

        const qty =
            parseFloat(
                (
                    (
                        botSettings.capital
                        *
                        botSettings.leverage
                    )
                    /
                    price
                ).toFixed(3)
            );

        await exchange.createOrder(
            pair,
            'MARKET',
            side === 'LONG'
                ? 'BUY'
                : 'SELL',
            qty,
            undefined,
            {
                positionSide: side
            }
        );

        const tp =
            side === 'LONG'
                ? price * (
                    1 + botSettings.tp / 100
                )
                : price * (
                    1 - botSettings.tp / 100
                );

        const sl =
            side === 'LONG'
                ? price * (
                    1 - botSettings.sl / 100
                )
                : price * (
                    1 + botSettings.sl / 100
                );

        const nextDcaPrice =
            side === 'LONG'
                ? price * (
                    1 - botSettings.dcaPercent / 100
                )
                : price * (
                    1 + botSettings.dcaPercent / 100
                );

        const margin =
            (
                (
                    qty * price
                )
                /
                botSettings.leverage
            );

        positions.set(key, {

            symbol,

            side,

            lev: botSettings.leverage,

            marginMode: 'CROSS',

            margin,

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

            c1: snap.c1,
            c5: snap.c5,
            c15: snap.c15
        });

        addLog(
            `🔔OPEN ${symbol} ${side} ${margin.toFixed(2)}$ CROSS ${botSettings.leverage}x ENTRY ${price.toFixed(6)} TP ${tp.toFixed(6)} SL ${sl.toFixed(6)} DCA 0 NEXT ${nextDcaPrice.toFixed(6)} 1M ${snap.c1}% 5M ${snap.c5}% 15M ${snap.c15}%`,
            symbol
        );

    } catch (e) {

        addLog(
            `⛔ ${e.message}`,
            symbol
        );
    }
}

function updatePositionsRealtime() {

    for (const [key, pos] of positions.entries()) {

        const livePrice =
            realtimePrice[pos.symbol];

        if (!livePrice) continue;

        pos.currentPrice =
            livePrice;

        pos.pnl =

            pos.side === 'LONG'

                ?

                (
                    (
                        livePrice
                        -
                        pos.entryInitial
                    )
                    /
                    pos.entryInitial
                ) * 100
                *
                pos.lev

                :

                (
                    (
                        pos.entryInitial
                        -
                        livePrice
                    )
                    /
                    pos.entryInitial
                ) * 100
                *
                pos.lev;

        const hitTP =

            (
                pos.side === 'LONG'
                &&
                livePrice >= pos.tp
            )

            ||

            (
                pos.side === 'SHORT'
                &&
                livePrice <= pos.tp
            );

        const hitSL =

            (
                pos.side === 'LONG'
                &&
                livePrice <= pos.sl
            )

            ||

            (
                pos.side === 'SHORT'
                &&
                livePrice >= pos.sl
            );

        if (hitTP) {

            stats.totalClosed++;

            stats.totalPnl += pos.pnl;

            addLog(
                `💲TP ${pos.symbol} ${livePrice.toFixed(6)} PNL ${pos.pnl.toFixed(2)}%`,
                pos.symbol
            );

            positions.delete(key);

            continue;
        }

        if (hitSL) {

            stats.totalClosed++;

            stats.totalPnl += pos.pnl;

            addLog(
                `❌SL ${pos.symbol} ${livePrice.toFixed(6)} LOSS ${pos.pnl.toFixed(2)}%`,
                pos.symbol
            );

            positions.delete(key);

            continue;
        }

        const dcaHit =

            (
                pos.side === 'LONG'
                &&
                livePrice <= pos.nextDcaPrice
            )

            ||

            (
                pos.side === 'SHORT'
                &&
                livePrice >= pos.nextDcaPrice
            );

        if (
            dcaHit
            &&
            pos.dcaLevel < 3
        ) {

            pos.dcaLevel++;

            stats.totalDca++;

            pos.avg =
                (
                    pos.avg
                    +
                    livePrice
                ) / 2;

            pos.nextDcaPrice =
                pos.side === 'LONG'
                    ? livePrice * (
                        1 - botSettings.dcaPercent / 100
                    )
                    : livePrice * (
                        1 + botSettings.dcaPercent / 100
                    );

            addLog(
                `📌DCA ${pos.symbol} LV${pos.dcaLevel} AVG ${pos.avg.toFixed(6)} NEXT ${pos.nextDcaPrice.toFixed(6)}`,
                pos.symbol
            );
        }

        positions.set(key, pos);
    }
}

function calcChange(arr, min) {

    if (!arr || arr.length < 2) {
        return 0;
    }

    const now =
        Date.now();

    const old =
        arr.find(
            x =>
                x.t >= (
                    now -
                    min * 60000
                )
        ) || arr[0];

    return (
        (
            (
                arr[arr.length - 1].p
                -
                old.p
            )
            /
            old.p
        ) * 100
    );
}

async function initFastWS() {

    const res =
        await fetch(
            'https://fapi.binance.com/fapi/v1/ticker/price'
        );

    const tickers =
        await res.json();

    const symbols =

        tickers

            .filter(
                t =>
                    t.symbol.endsWith('USDT')
            )

            .slice(0, 150)

            .map(
                t =>
                    `${t.symbol.toLowerCase()}@ticker`
            );

    const ws =
        new WebSocket(
            `wss://fstream.binance.com/stream?streams=${symbols.join('/')}`
        );

    ws.on('open', () => {

        addLog(
            '📡 FAST WS CONNECTED'
        );
    });

    ws.on('message', raw => {

        try {

            const msg =
                JSON.parse(raw);

            if (!msg.data) return;

            const t =
                msg.data;

            const symbol =
                t.s.replace(
                    'USDT',
                    ''
                );

            const price =
                parseFloat(t.c);

            realtimePrice[symbol] =
                price;

            const now =
                Date.now();

            if (!priceHistory[symbol]) {
                priceHistory[symbol] = [];
            }

            priceHistory[symbol].push({
                p: price,
                t: now
            });

            if (
                priceHistory[symbol].length > 1500
            ) {
                priceHistory[symbol].shift();
            }

            const c1 =
                calcChange(
                    priceHistory[symbol],
                    1
                );

            const c5 =
                calcChange(
                    priceHistory[symbol],
                    5
                );

            const c15 =
                calcChange(
                    priceHistory[symbol],
                    15
                );

            coinData[symbol] = {

                symbol,

                currentPrice: price,

                c1,

                c5,

                c15,

                volatilityScore:
                    Math.abs(c1)
                    +
                    Math.abs(c5)
                    +
                    Math.abs(c15)
            };

            if (
                botSettings.isRunning
                &&
                Math.abs(c15)
                >= botSettings.volVolatility
            ) {

                openPosition(
                    symbol,
                    c15 >= 0
                        ? 'LONG'
                        : 'SHORT',
                    price,
                    {
                        c1: c1.toFixed(2),
                        c5: c5.toFixed(2),
                        c15: c15.toFixed(2)
                    }
                );
            }

        } catch (e) {}
    });

    ws.on('close', () => {

        addLog(
            '❌ WS CLOSED'
        );

        setTimeout(
            initFastWS,
            1000
        );
    });

    ws.on('error', () => {

        ws.close();
    });
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

        botIp:
            `http://localhost:${PORT}`,

        wallet: walletCache,

        activePositions:
            Array.from(
                positions.values()
            ),

        market: top10,

        stats: {

            openPositions:
                positions.size,

            totalClosed:
                stats.totalClosed,

            totalDca:
                stats.totalDca,

            totalPnl:
                stats.totalPnl.toFixed(2)
        },

        status,

        botStatus:
            botSettings.isRunning
                ? 'RUNNING'
                : 'STOPPED'
    });
});

app.post('/api/config', (req, res) => {

    botSettings = {
        ...botSettings,
        ...req.body
    };

    addLog(
        '⚙ CONFIG UPDATED'
    );

    res.json({
        ok: true
    });
});

app.post('/api/start', (req, res) => {

    botSettings.isRunning = true;

    addLog(
        '🚀 BOT STARTED'
    );

    res.json({
        ok: true
    });
});

app.post('/api/stop', (req, res) => {

    botSettings.isRunning = false;

    addLog(
        '🛑 BOT STOPPED'
    );

    res.json({
        ok: true
    });
});

app.post('/api/closeall', (req, res) => {

    positions.clear();

    addLog(
        '🧹 ALL CLOSED'
    );

    res.json({
        ok: true
    });
});

app.listen(PORT, async () => {

    console.log(
        `🚀 http://localhost:${PORT}`
    );

    addLog(
        '🚀 BOT READY'
    );

    preloadWallet();

    setInterval(
        preloadWallet,
        5000
    );

    setInterval(
        updatePositionsRealtime,
        100
    );

    initFastWS();
});
