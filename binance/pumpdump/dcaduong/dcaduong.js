import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;

const __dirname =
    path.dirname(
        fileURLToPath(import.meta.url)
    );

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

// =========================
// BINANCE
// =========================
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

// =========================
// STATE
// =========================
let botSettings = {

    isRunning: false,

    capital: 5,

    volVolatility: 6.5,

    maxPos: 3,

    dcaPercent: 10,

    tp: 0.5,

    sl: 10
};

let coinData = {};

let positions = new Map();

let status = {

    botLogs: []
};

let walletCache = {

    totalWalletBalance: '0.00',

    availableBalance: '0.00',

    totalUnrealizedProfit: '0.00'
};

let marketReady = false;

let exchangeInfo = {};

let recentLogs = new Set();

// =========================
// HELPERS
// =========================
function toCCXTSymbol(symbol) {

    return symbol.replace(
        'USDT',
        '/USDT:USDT'
    );
}

function getLocalIP() {

    const nets =
        os.networkInterfaces();

    for (const name of Object.keys(nets)) {

        for (const net of nets[name]) {

            if (
                net.family === 'IPv4' &&
                !net.internal
            ) {
                return net.address;
            }
        }
    }

    return '0.0.0.0';
}

// =========================
// LOG
// =========================
function addLog(
    msg,
    symbol = '',
    side = ''
) {

    const key =
        `${msg}_${symbol}_${side}`;

    if (
        recentLogs.has(key)
    ) return;

    recentLogs.add(key);

    setTimeout(() => {

        recentLogs.delete(key);

    }, 4000);

    const time =
        new Date().toLocaleTimeString(
            'vi-VN',
            { hour12: false }
        );

    status.botLogs.unshift({

        time,
        msg,
        symbol,
        side
    });

    if (
        status.botLogs.length > 300
    ) {

        status.botLogs.pop();
    }

    console.log(
        `[${time}] ${symbol} ${msg}`
    );
}

// =========================
// SAVE
// =========================
function saveState() {

    fs.writeFileSync(

        'config_data.json',

        JSON.stringify(
            botSettings,
            null,
            2
        )
    );

    fs.writeFileSync(

        'positions.json',

        JSON.stringify(
            Array.from(
                positions.values()
            ),
            null,
            2
        )
    );
}

// =========================
// WALLET
// =========================
async function preloadWallet() {

    try {

        const acc =
            await exchange.fetchBalance();

        walletCache = {

            totalWalletBalance:

                parseFloat(
                    acc.info
                        ?.totalWalletBalance || 0
                ).toFixed(2),

            availableBalance:

                parseFloat(
                    acc.info
                        ?.availableBalance || 0
                ).toFixed(2),

            totalUnrealizedProfit:

                parseFloat(
                    acc.info
                        ?.totalUnrealizedProfit || 0
                ).toFixed(2)
        };

    } catch (e) {

        addLog(
            `WALLET ERROR ${e.message}`
        );
    }
}

async function walletLoop() {

    await preloadWallet();

    setTimeout(
        walletLoop,
        5000
    );
}

// =========================
// LOAD MARKET INFO
// =========================
async function loadExchangeInfo() {

    try {

        const markets =
            await exchange.loadMarkets();

        for (const [k, v]
            of Object.entries(markets)
        ) {

            if (
                !k.includes('/USDT')
            ) continue;

            exchangeInfo[k] = {

                minCost:
                    Math.max(
                        v.limits?.cost?.min || 5.5,
                        5.5
                    ),

                minQty:
                    v.limits?.amount?.min || 0,

                qtyPrecision:
                    v.precision?.amount || 3,

                pricePrecision:
                    v.precision?.price || 4
            };
        }

        addLog(
            'EXCHANGE READY'
        );

    } catch (e) {

        addLog(
            `EXCHANGE ERROR ${e.message}`
        );
    }
}

// =========================
// VOLATILITY
// =========================
async function initWS() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/24hr'
            );

        const arr =
            res.data

            .filter(
                s =>
                    s.symbol.endsWith(
                        'USDT'
                    )
            )

            .sort((a, b) =>

                Math.abs(
                    parseFloat(
                        b.priceChangePercent
                    )
                )

                -

                Math.abs(
                    parseFloat(
                        a.priceChangePercent
                    )
                )
            )

            .slice(0, 120);

        arr.forEach(c => {

            const vol =
                parseFloat(
                    c.priceChangePercent
                );

            const price =
                parseFloat(
                    c.lastPrice
                );

            coinData[c.symbol] = {

                live: {

                    price,

                    c1:
                        vol / 24,

                    c5:
                        vol / 12,

                    c15:
                        vol / 6
                }
            };
        });

        marketReady = true;

    } catch (e) {

        addLog(
            `MARKET ERROR ${e.message}`
        );
    }

    setTimeout(
        initWS,
        5000
    );
}

// =========================
// MAX LEV
// =========================
async function getMaxLeverage(symbol) {

    try {

        const brackets =
            await exchange.fapiPrivateGetLeverageBracket();

        const found =
            brackets.find(
                b =>
                    b.symbol ===
                    symbol
            );

        return parseInt(
            found
                ?.brackets?.[0]
                ?.initialLeverage || 20
        );

    } catch {

        return 20;
    }
}

// =========================
// TP SL
// =========================
async function syncTPSL(
    pair,
    side,
    tp,
    sl
) {

    try {

        const closeSide =
            side === 'LONG'
                ? 'SELL'
                : 'BUY';

        try {

            const orders =
                await exchange.fetchOpenOrders(
                    pair
                );

            for (const o of orders) {

                if (
                    o.info.positionSide === side
                ) {

                    await exchange.cancelOrder(
                        o.id,
                        pair
                    );
                }
            }

        } catch {}

        const precision =
            exchangeInfo[pair]
                ?.pricePrecision || 4;

        await exchange.createOrder(

            pair,

            'TAKE_PROFIT_MARKET',

            closeSide,

            undefined,

            undefined,

            {

                positionSide: side,

                stopPrice:
                    parseFloat(
                        tp.toFixed(
                            precision
                        )
                    ),

                closePosition: true,

                workingType:
                    'MARK_PRICE'
            }
        );

        await exchange.createOrder(

            pair,

            'STOP_MARKET',

            closeSide,

            undefined,

            undefined,

            {

                positionSide: side,

                stopPrice:
                    parseFloat(
                        sl.toFixed(
                            precision
                        )
                    ),

                closePosition: true,

                workingType:
                    'MARK_PRICE'
            }
        );

        addLog(
            'TPSL READY',
            pair,
            side
        );

    } catch (e) {

        addLog(
            `TPSL ERROR ${e.message}`,
            pair,
            side
        );
    }
}

// =========================
// OPEN POSITION
// =========================
async function openPosition(
    symbol,
    side,
    price
) {

    try {

        if (
            !botSettings.isRunning
        ) return;

        if (
            positions.size >=
            botSettings.maxPos
        ) return;

        const key =
            `${symbol}_${side}`;

        if (
            positions.has(key)
        ) return;

        const pair =
            toCCXTSymbol(symbol);

        const info =
            exchangeInfo[pair];

        if (!info)
            return;

        const lev =
            await getMaxLeverage(symbol);

        let qty =
            (
                botSettings.capital *
                lev
            ) / price;

        const minForceQty =
            info.minCost / price;

        qty = Math.max(
            qty,
            minForceQty,
            info.minQty
        );

        qty =
            parseFloat(
                exchange.amountToPrecision(
                    pair,
                    qty
                )
            );

        if (
            !qty ||
            qty <= 0
        ) return;

        try {

            await exchange.setLeverage(
                lev,
                pair
            );

        } catch {}

        const order =
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

                ? price *

                  (
                      1 +
                      botSettings.tp / 100
                  )

                : price *

                  (
                      1 -
                      botSettings.tp / 100
                  );

        const sl =

            side === 'LONG'

                ? price *

                  (
                      1 -
                      botSettings.sl / 100
                  )

                : price *

                  (
                      1 +
                      botSettings.sl / 100
                  );

        await syncTPSL(
            pair,
            side,
            tp,
            sl
        );

        positions.set(key, {

            symbol,

            side,

            qty,

            leverage: lev,

            avg: price,

            entryInitial: price,

            tp,

            sl,

            pnl: 0,

            unrealized: 0,

            liquidationPrice: 0,

            markPrice: price,

            dca: 0,

            startTime:
                Date.now()
        });

        addLog(

            `OPEN ${lev}x ${qty}`,

            symbol,

            side
        );

        saveState();

    } catch (e) {

        addLog(

            `OPEN ERROR ${e.message}`,

            symbol,

            side
        );
    }
}

// =========================
// REAL POSITION RISK
// =========================
async function positionRiskLoop() {

    try {

        const risk =
            await exchange.fetchPositions();

        risk.forEach(r => {

            const contracts =
                parseFloat(
                    r.contracts || 0
                );

            if (
                !contracts ||
                contracts === 0
            ) return;

            const symbol =
                r.symbol.replace(
                    '/USDT:USDT',
                    'USDT'
                );

            const side =
                contracts > 0
                    ? 'LONG'
                    : 'SHORT';

            const key =
                `${symbol}_${side}`;

            const pos =
                positions.get(key);

            if (!pos)
                return;

            pos.pnl =
                parseFloat(
                    r.percentage || 0
                );

            pos.unrealized =
                parseFloat(
                    r.unrealizedPnl || 0
                );

            pos.markPrice =
                parseFloat(
                    r.markPrice || 0
                );

            pos.notional =
                parseFloat(
                    r.notional || 0
                );

            pos.liquidationPrice =
                parseFloat(
                    r.liquidationPrice || 0
                );
        });

    } catch (e) {

        addLog(
            `PNL ERROR ${e.message}`
        );
    }

    setTimeout(
        positionRiskLoop,
        2000
    );
}

// =========================
// CLOSE
// =========================
async function closePosition(
    p
) {

    try {

        await exchange.createOrder(

            toCCXTSymbol(
                p.symbol
            ),

            'MARKET',

            p.side === 'LONG'
                ? 'SELL'
                : 'BUY',

            p.qty,

            undefined,

            {

                reduceOnly: true,

                positionSide:
                    p.side
            }
        );

        addLog(

            `CLOSE ${p.pnl.toFixed(2)}% ${p.unrealized.toFixed(2)}$`,

            p.symbol,

            p.side
        );

    } catch (e) {

        addLog(

            `CLOSE ERROR ${e.message}`,

            p.symbol,

            p.side
        );
    }
}

// =========================
// MONITOR
// =========================
async function monitorLoop() {

    for (const [key, p]
        of positions
    ) {

        try {

            const tpHit =

                p.side === 'LONG'

                    ? p.markPrice >= p.tp

                    : p.markPrice <= p.tp;

            const slHit =

                p.side === 'LONG'

                    ? p.markPrice <= p.sl

                    : p.markPrice >= p.sl;

            if (
                tpHit ||
                slHit
            ) {

                await closePosition(
                    p
                );

                positions.delete(key);

                saveState();
            }

        } catch {}
    }

    setTimeout(
        monitorLoop,
        1000
    );
}

// =========================
// AUTO TRADE
// =========================
async function autoTradeLoop() {

    try {

        if (
            !botSettings.isRunning
        ) {

            setTimeout(
                autoTradeLoop,
                2000
            );

            return;
        }

        for (const [s, v]
            of Object.entries(
                coinData
            )
        ) {

            if (!v.live)
                continue;

            const {
                c1,
                c5,
                c15
            } = v.live;

            const valid =

                Math.abs(c1)
                    >= botSettings.volVolatility ||

                Math.abs(c5)
                    >= botSettings.volVolatility ||

                Math.abs(c15)
                    >= botSettings.volVolatility;

            if (!valid)
                continue;

            const side =

                (
                    c1 +
                    c5 +
                    c15
                ) >= 0

                    ? 'LONG'
                    : 'SHORT';

            addLog(

                `TARGET ${s} M1:${c1.toFixed(2)} M5:${c5.toFixed(2)} M15:${c15.toFixed(2)}`,

                s,

                side
            );

            await openPosition(
                s,
                side,
                v.live.price
            );

            break;
        }

    } catch (e) {

        addLog(
            `AUTO ERROR ${e.message}`
        );
    }

    setTimeout(
        autoTradeLoop,
        2000
    );
}

// =========================
// API
// =========================
app.post(
    '/api/config',
    (req, res) => {

        botSettings = {

            ...botSettings,

            ...req.body
        };

        saveState();

        res.json({
            ok: true
        });
    }
);

app.post(
    '/api/start',
    (req, res) => {

        botSettings.isRunning = true;

        addLog(
            'BOT START'
        );

        saveState();

        res.json({
            ok: true
        });
    }
);

app.post(
    '/api/stop',
    (req, res) => {

        botSettings.isRunning = false;

        addLog(
            'BOT STOP'
        );

        saveState();

        res.json({
            ok: true
        });
    }
);

app.post(
    '/api/closeall',

    async (req, res) => {

        try {

            for (const [key, p]
                of positions
            ) {

                await closePosition(
                    p
                );

                positions.delete(key);
            }

            saveState();

            res.json({
                ok: true
            });

        } catch (e) {

            res.json({
                ok: false,
                error: e.message
            });
        }
    }
);

app.get(
    '/api/status',

    async (req, res) => {

        const market =

            Object.entries(coinData)

            .filter(
                ([_, v]) =>
                    v.live
            )

            .map(([s, v]) => ({

                symbol: s,

                c1:
                    v.live.c1 || 0,

                c5:
                    v.live.c5 || 0,

                c15:
                    v.live.c15 || 0,

                price:
                    v.live.price || 0
            }))

            .sort((a, b) =>

                Math.abs(
                    b.c1 +
                    b.c5 +
                    b.c15
                )

                -

                Math.abs(
                    a.c1 +
                    a.c5 +
                    a.c15
                )
            )

            .slice(0, 40);

        res.json({

            ready: {

                market:
                    marketReady,

                wallet: true
            },

            botIp:
                getLocalIP(),

            wallet:
                walletCache,

            botStatus:

                botSettings.isRunning
                    ? 'RUNNING'
                    : 'STOPPED',

            market,

            activePositions:
                Array.from(
                    positions.values()
                ),

            status
        });
    }
);

// =========================
// START
// =========================
app.listen(PORT, async () => {

    console.log(
        `BOT RUNNING ${PORT}`
    );

    await loadExchangeInfo();

    await preloadWallet();

    initWS();

    walletLoop();

    autoTradeLoop();

    monitorLoop();

    positionRiskLoop();

    addLog(
        'SYSTEM READY'
    );
});
