import express from 'express';
import ccxt from 'ccxt';
import WebSocket from 'ws';
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
    volVolatility: 5,
    maxPos: 5,
    tp: 0.5,
    sl: 10,
    leverage: 20,
    dcaPercent: 10
};

let wallet = {
    totalWalletBalance: '0.00',
    availableBalance: '0.00',
    totalUnrealizedProfit: '0.00'
};

let stats = {
    totalClosed: 0,
    totalDca: 0,
    totalPnl: 0
};

let logs = [];

let realtimePrice = {};
let coinData = {};
let priceCache = {};

let positions = new Map();

function addLog(msg, symbol = '') {

    const log = {
        time: new Date().toLocaleTimeString('vi-VN', {
            hour12: false
        }),
        symbol,
        msg
    };

    logs.unshift(log);

    if (logs.length > 200) {
        logs.pop();
    }

    console.log(
        `[${log.time}] ${symbol} ${msg}`
    );
}

async function updateWallet() {

    try {

        const balance =
            await exchange.fetchBalance();

        wallet = {

            totalWalletBalance:
                parseFloat(
                    balance.info?.totalMarginBalance || 0
                ).toFixed(2),

            availableBalance:
                parseFloat(
                    balance.info?.availableBalance || 0
                ).toFixed(2),

            totalUnrealizedProfit:
                parseFloat(
                    balance.info?.totalUnrealizedProfit || 0
                ).toFixed(2)
        };

    } catch (e) {

        addLog(
            `⛔ WALLET ${e.message}`
        );
    }
}

async function setCross(pair) {

    try {

        await exchange.setMarginMode(
            'cross',
            pair
        );

    } catch (e) {}
}

function buildPosition(
    symbol,
    side,
    price,
    qty,
    snap
) {

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

        marginMode: 'CROSS',

        margin:
            parseFloat(
                (
                    (
                        qty * price
                    )
                    /
                    botSettings.leverage
                ).toFixed(2)
            ),

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

async function openPosition(
    symbol,
    side,
    price,
    snap
) {

    if (!botSettings.isRunning) return;

    if (positions.size >= botSettings.maxPos) return;

    const key =
        `${symbol}-${side}`;

    if (positions.has(key)) return;

    try {

        const pair =
            `${symbol}/USDT`;

        await setCross(pair);

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

        const pos =
            buildPosition(
                symbol,
                side,
                price,
                qty,
                snap
            );

        positions.set(key, pos);

        addLog(
            `🔔OPEN ${symbol} ${side} ${pos.margin}$ CROSS ${botSettings.leverage}x ENTRY ${price.toFixed(6)} TP ${pos.tp.toFixed(6)} SL ${pos.sl.toFixed(6)} DCA ${pos.dcaLevel} NEXT ${pos.nextDcaPrice.toFixed(6)} 1M ${snap.c1}% 5M ${snap.c5}% 15M ${snap.c15}%`,
            symbol
        );

    } catch (e) {

        addLog(
            `⛔ ${e.message}`,
            symbol
        );
    }
}

function updatePositions() {

    for (const [key, pos] of positions.entries()) {

        const price =
            realtimePrice[pos.symbol];

        if (!price) continue;

        pos.currentPrice = price;

        pos.pnl =
            pos.side === 'LONG'

                ?

                (
                    (
                        price
                        -
                        pos.entryInitial
                    )
                    /
                    pos.entryInitial
                ) * 100

                :

                (
                    (
                        pos.entryInitial
                        -
                        price
                    )
                    /
                    pos.entryInitial
                ) * 100;

        const tpHit =

            (
                pos.side === 'LONG'
                &&
                price >= pos.tp
            )

            ||

            (
                pos.side === 'SHORT'
                &&
                price <= pos.tp
            );

        const slHit =

            (
                pos.side === 'LONG'
                &&
                price <= pos.sl
            )

            ||

            (
                pos.side === 'SHORT'
                &&
                price >= pos.sl
            );

        if (tpHit) {

            stats.totalClosed++;

            stats.totalPnl += pos.pnl;

            addLog(
                `💲TP ${pos.symbol} PNL ${pos.pnl.toFixed(2)}%`,
                pos.symbol
            );

            positions.delete(key);

            continue;
        }

        if (slHit) {

            stats.totalClosed++;

            stats.totalPnl += pos.pnl;

            addLog(
                `❌SL ${pos.symbol} LOSS ${Math.abs(pos.pnl).toFixed(2)}% PRICE ${price.toFixed(6)} PNL ${pos.pnl.toFixed(2)}%`,
                pos.symbol
            );

            positions.delete(key);

            continue;
        }

        if (
            Math.abs(pos.pnl) <= 0.15
            &&
            pos.dcaLevel > 0
        ) {

            addLog(
                `💵BE ${pos.symbol} PNL ${pos.pnl.toFixed(2)}%`,
                pos.symbol
            );
        }

        const dcaHit =

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
                    price
                ) / 2;

            pos.nextDcaPrice =
                pos.side === 'LONG'
                    ? price * (
                        1 -
                        botSettings.dcaPercent / 100
                    )
                    : price * (
                        1 +
                        botSettings.dcaPercent / 100
                    );

            addLog(
                `📌DCA ${pos.symbol} LV${pos.dcaLevel} AVG ${pos.avg.toFixed(6)} NEXT ${pos.nextDcaPrice.toFixed(6)}`,
                pos.symbol
            );
        }

        positions.set(key, pos);
    }
}

function startMarketStream() {

    const ws = new WebSocket(
        'wss://fstream.binance.com/ws/!miniTicker@arr'
    );

    ws.on('open', () => {

        addLog(
            '📡 MARKET WS CONNECTED'
        );
    });

    ws.on('message', raw => {

        try {

            const data =
                JSON.parse(raw);

            const now =
                Date.now();

            for (const t of data) {

                if (
                    !t.s.endsWith('USDT')
                ) continue;

                const symbol =
                    t.s.replace(
                        'USDT',
                        ''
                    );

                const price =
                    parseFloat(t.c);

                realtimePrice[symbol] = price;

                if (!priceCache[symbol]) {
                    priceCache[symbol] = [];
                }

                priceCache[symbol].push({
                    time: now,
                    price
                });

                priceCache[symbol] =
                    priceCache[symbol].filter(
                        x =>
                            now - x.time
                            <=
                            15 * 60 * 1000
                    );

                const arr =
                    priceCache[symbol];

                const oldPrice = ms => {

                    const found =
                        arr.find(
                            x =>
                                now - x.time >= ms
                        );

                    return found?.price || price;
                };

                const p1 =
                    oldPrice(
                        60 * 1000
                    );

                const p5 =
                    oldPrice(
                        5 * 60 * 1000
                    );

                const p15 =
                    oldPrice(
                        15 * 60 * 1000
                    );

                const c1 =
                    (
                        (
                            price - p1
                        ) / p1
                    ) * 100;

                const c5 =
                    (
                        (
                            price - p5
                        ) / p5
                    ) * 100;

                const c15 =
                    (
                        (
                            price - p15
                        ) / p15
                    ) * 100;

                const volatilityScore =
                    Math.abs(c1)
                    +
                    Math.abs(c5)
                    +
                    Math.abs(c15);

                coinData[symbol] = {

                    symbol,

                    price,

                    c1,

                    c5,

                    c15,

                    volatilityScore
                };

                if (
                    botSettings.isRunning
                    &&
                    Math.abs(c15)
                    >=
                    botSettings.volVolatility
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
            }

            updatePositions();

        } catch (e) {

            addLog(
                `⛔ WS ${e.message}`
            );
        }
    });

    ws.on('close', () => {

        addLog(
            '❌ WS CLOSED'
        );

        setTimeout(
            startMarketStream,
            3000
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

        botStatus:
            botSettings.isRunning
                ? 'RUNNING'
                : 'STOPPED',

        wallet,

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

        market: top10,

        activePositions:
            Array.from(
                positions.values()
            ),

        logs
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
        '🧹 ALL POSITIONS CLOSED'
    );

    res.json({
        ok: true
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

app.listen(PORT, async () => {

    addLog(
        '🚀 BOT READY'
    );

    updateWallet();

    startMarketStream();

    setInterval(
        updateWallet,
        5000
    );

    console.log(
        `RUNNING http://localhost:${PORT}`
    );
});
