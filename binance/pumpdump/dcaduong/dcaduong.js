import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

const recentLogs = new Map();

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

    const nets = os.networkInterfaces();

    for (const name of Object.keys(nets)) {

        for (const net of nets[name]) {

            if (
                net.family === 'IPv4'
                &&
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

    const now = Date.now();

    if (recentLogs.has(key)) {

        const last =
            recentLogs.get(key);

        if (
            now - last < 15000
        ) return;
    }

    recentLogs.set(key, now);

    for (const [k, v] of recentLogs) {

        if (now - v > 30000) {
            recentLogs.delete(k);
        }
    }

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
// EXCHANGE INFO
// =========================
async function loadExchangeInfo() {

    try {

        const markets =
            await exchange.loadMarkets();

        for (
            const [k, v]
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
                    v.precision?.price || 5
            };
        }

        addLog('EXCHANGE READY');

    } catch (e) {

        addLog(
            `EXCHANGE ERROR ${e.message}`
        );
    }
}

// =========================
// REALTIME VOLATILITY
// =========================
function calcChange(
    arr,
    min
) {

    if (
        !arr ||
        arr.length < 2
    ) return 0;

    const now = Date.now();

    const old =
        arr.find(
            x =>
                x.t >=
                now - (
                    min * 60000
                )
        ) || arr[0];

    const latest =
        arr[arr.length - 1];

    return (
        (
            latest.p - old.p
        ) / old.p
    ) * 100;
}

async function initWS() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const symbols =
            res.data
                .filter(
                    x =>
                        x.symbol.endsWith(
                            'USDT'
                        )
                )
                .slice(0, 150)
                .map(
                    x =>
                        x.symbol.toLowerCase()
                );

        const ws = new WebSocket(
            `wss://fstream.binance.com/stream?streams=${
                symbols.map(
                    s => `${s}@ticker`
                ).join('/')
            }`
        );

        ws.on(
            'open',
            () => {

                marketReady = true;

                addLog(
                    'MARKET WS READY'
                );
            }
        );

        ws.on(
            'message',
            raw => {

                try {

                    const json =
                        JSON.parse(raw);

                    if (!json.data)
                        return;

                    const s =
                        json.data.s;

                    const p =
                        parseFloat(
                            json.data.c
                        );

                    if (!coinData[s]) {

                        coinData[s] = {
                            prices: [],
                            live: {}
                        };
                    }

                    coinData[s]
                        .prices
                        .push({
                            p,
                            t: Date.now()
                        });

                    if (
                        coinData[s]
                            .prices
                            .length > 2000
                    ) {

                        coinData[s]
                            .prices
                            .shift();
                    }

                    coinData[s].live = {

                        price: p,

                        c1:
                            calcChange(
                                coinData[s].prices,
                                1
                            ),

                        c5:
                            calcChange(
                                coinData[s].prices,
                                5
                            ),

                        c15:
                            calcChange(
                                coinData[s].prices,
                                15
                            )
                    };

                } catch {}
            }
        );

        ws.on(
            'close',
            () => {

                addLog(
                    'WS RECONNECT'
                );

                setTimeout(
                    initWS,
                    3000
                );
            }
        );

    } catch (e) {

        addLog(
            `WS ERROR ${e.message}`
        );

        setTimeout(
            initWS,
            5000
        );
    }
}

// =========================
// MAX LEV
// =========================
async function getMaxLeverage(
    symbol
) {

    try {

        const brackets =
            await exchange.fapiPrivateGetLeverageBracket();

        const found =
            brackets.find(
                b =>
                    b.symbol === symbol
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

        const tpPrice =
            parseFloat(
                exchange.priceToPrecision(
                    pair,
                    tp
                )
            );

        const slPrice =
            parseFloat(
                exchange.priceToPrecision(
                    pair,
                    sl
                )
            );

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

        await exchange.createOrder(
            pair,
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
            pair,
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

        return {
            tp: tpPrice,
            sl: slPrice
        };

    } catch (e) {

        addLog(
            `TPSL ERROR ${e.message}`,
            pair,
            side
        );

        return {
            tp: 0,
            sl: 0
        };
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
            await getMaxLeverage(
                symbol
            );

        let qty =
            (
                botSettings.capital *
                lev
            ) / price;

        const minQty =
            5.5 / price;

        qty = Math.max(
            qty,
            minQty,
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
                    1 + (
                        botSettings.tp / 100
                    )
                )
                : price * (
                    1 - (
                        botSettings.tp / 100
                    )
                );

        const sl =
            side === 'LONG'
                ? price * (
                    1 - (
                        botSettings.sl / 100
                    )
                )
                : price * (
                    1 + (
                        botSettings.sl / 100
                    )
                );

        const synced =
            await syncTPSL(
                pair,
                side,
                tp,
                sl
            );

        const nextDca =
            side === 'LONG'
                ? price * (
                    1 - (
                        botSettings.dcaPercent / 100
                    )
                )
                : price * (
                    1 + (
                        botSettings.dcaPercent / 100
                    )
                );

        positions.set(
            key,
            {

                symbol,
                side,

                qty,

                leverage: lev,

                avg: price,

                entryInitial: price,

                tp: synced.tp,

                sl: synced.sl,

                nextDca,

                pnl: 0,

                unrealized: 0,

                roi: 0,

                dca: 0,

                margin:
                    (
                        qty * price
                    ) / lev,

                markPrice: price,

                liquidationPrice: 0,

                startTime:
                    Date.now()
            }
        );

        addLog(

            `OPEN | `
            + `Coin:${symbol} | `
            + `Side:${side} | `
            + `Margin:${(
                (
                    qty * price
                ) / lev
            ).toFixed(2)}$ | `
            + `Lev:${lev}x | `
            + `Entry:${price} | `
            + `TP:${synced.tp} | `
            + `SL:${synced.sl} | `
            + `DCA:${nextDca}`,

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
// REAL PNL
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

            pos.roi =
                parseFloat(
                    r.percentage || 0
                );

            pos.pnl =
                parseFloat(
                    r.unrealizedPnl || 0
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
                positionSide:
                    p.side
            }
        );

        addLog(

            `CLOSE | `
            + `Coin:${p.symbol} | `
            + `ROI:${p.roi.toFixed(2)}% | `
            + `PNL:${p.pnl.toFixed(2)}$`,

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

    for (
        const [key, p]
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
let lastTargetCoin = '';
let lastTargetTime = 0;

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

        for (
            const [s, v]
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
                    >= botSettings.volVolatility

                ||

                Math.abs(c5)
                    >= botSettings.volVolatility

                ||

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

            const now =
                Date.now();

            if (
                lastTargetCoin !== s
                ||
                now - lastTargetTime > 15000
            ) {

                addLog(

                    `TARGET ${s} `
                    + `M1:${c1.toFixed(2)} `
                    + `M5:${c5.toFixed(2)} `
                    + `M15:${c15.toFixed(2)}`,

                    s,
                    side
                );

                lastTargetCoin = s;
                lastTargetTime = now;
            }

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

            for (
                const [key, p]
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

            Object.entries(
                coinData
            )

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
app.listen(
    PORT,

    async () => {

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
    }
);
