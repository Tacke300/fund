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
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

// =========================
// BINANCE FUTURES
// =========================
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        hedgeMode: true
    }
});

// =========================
// STATE
// =========================
let botSettings = {

    isRunning: false,

    capital: 5,

    volVolatility: 6,

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

function addLog(
    msg,
    symbol = null,
    side = null
) {

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
        `[${time}] ${symbol || ''} ${msg}`
    );
}

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

function change(arr, min) {

    if (
        !arr ||
        arr.length < 2
    ) {
        return 0;
    }

    const now = Date.now();

    const start =

        arr.find(
            i =>
                i.t >=
                now -
                min * 60000
        )

        ||

        arr[0];

    return (
        (
            (
                arr.at(-1).p -
                start.p
            )

            /

            start.p
        ) * 100
    );
}

// =========================
// GET MAX LEVERAGE
// =========================
async function getMaxLeverage(pair) {

    try {

        const brackets =
            await exchange.fapiPrivateGetLeverageBracket();

        const found =
            brackets.find(
                b =>
                    b.symbol ===
                    pair
                        .replace('/USDT:USDT', '')
            );

        if (!found)
            return 20;

        return parseInt(
            found.brackets?.[0]
                ?.initialLeverage || 20
        );

    } catch {

        return 20;
    }
}

// =========================
// MARKET WS
// =========================
async function initWS() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const symbols =
            res.data

                .filter(
                    t =>
                        t.symbol.endsWith(
                            'USDT'
                        )
                )

                .map(
                    t => t.symbol.toLowerCase()
                )

                .slice(0, 80);

        const ws =
            new WebSocket(

                `wss://fstream.binance.com/stream?streams=${
                    symbols
                        .map(
                            s =>
                                `${s}@ticker`
                        )
                        .join('/')
                }`
            );

        ws.on(
            'open',
            () => {
                addLog(
                    'WS CONNECTED'
                );
            }
        );

        ws.on(
            'message',
            raw => {

                try {

                    const msg =
                        JSON.parse(raw);

                    if (!msg.data)
                        return;

                    const s =
                        msg.data.s;

                    const p =
                        parseFloat(
                            msg.data.c
                        );

                    if (!coinData[s]) {

                        coinData[s] = {
                            prices: []
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
                            .length > 500
                    ) {

                        coinData[s]
                            .prices
                            .shift();
                    }

                    coinData[s].live = {

                        price: p,

                        c1: change(
                            coinData[s]
                                .prices,
                            1
                        ),

                        c5: change(
                            coinData[s]
                                .prices,
                            5
                        ),

                        c15: change(
                            coinData[s]
                                .prices,
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

        console.log(e);

        setTimeout(
            initWS,
            5000
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

        if (!botSettings.isRunning)
            return;

        if (
            positions.size >=
            botSettings.maxPos
        ) {
            return;
        }

        const key =
            `${symbol}_${side}`;

        if (positions.has(key))
            return;

        const pair =
            toCCXTSymbol(symbol);

        // =====================
        // MAX LEVERAGE
        // =====================
        const lev =
            await getMaxLeverage(pair);

        // =====================
        // MARKET INFO
        // =====================
        const markets =
            await exchange.loadMarkets();

        const marketInfo =
            markets[pair];

        if (!marketInfo) {

            addLog(
                'MARKET NOT FOUND',
                symbol,
                side
            );

            return;
        }

        // =====================
        // MIN LIMITS
        // =====================
        const minCost =
            marketInfo.limits
                ?.cost?.min || 5.5;

        const minQty =
            marketInfo.limits
                ?.amount?.min || 0;

        // =====================
        // CALCULATE QTY
        // =====================
        let qty =
            (
                botSettings.capital *
                lev
            ) / price;

        const minRequiredQty =
            minCost / price;

        // =====================
        // FORCE MINIMUM
        // =====================
        qty = Math.max(
            qty,
            minRequiredQty,
            minQty
        );

        // =====================
        // PRECISION
        // =====================
        qty =
            exchange.amountToPrecision(
                pair,
                qty
            );

        qty =
            parseFloat(qty);

        if (
            !qty ||
            qty <= 0 ||
            isNaN(qty)
        ) {

            addLog(
                'INVALID QTY',
                symbol,
                side
            );

            return;
        }

        const finalNotional =
            qty * price;

        // =====================
        // LOG MIN FORCE
        // =====================
        if (
            finalNotional >
            (
                botSettings.capital *
                lev
            )
        ) {

            addLog(
                `MIN FORCE ${finalNotional.toFixed(2)}$`,
                symbol,
                side
            );
        }

        // =====================
        // SET LEVERAGE
        // =====================
        try {

            await exchange.setLeverage(
                lev,
                pair
            );

        } catch {}

        // =====================
        // OPEN ORDER
        // =====================
        await exchange.createOrder(

            pair,

            'market',

            side === 'LONG'
                ? 'buy'
                : 'sell',

            qty,

            undefined,

            {
                positionSide: side
            }
        );

        // =====================
        // SAVE POSITION
        // =====================
        positions.set(key, {

            symbol,

            side,

            qty,

            leverage: lev,

            avg: price,

            entryInitial: price,

            marginInitial:
                finalNotional / lev,

            notional:
                finalNotional,

            dca: 0,

            tp:

                side === 'LONG'

                    ? price *

                      (
                          1 +
                          botSettings.tp /
                          100
                      )

                    : price *

                      (
                          1 -
                          botSettings.tp /
                          100
                      ),

            sl:

                side === 'LONG'

                    ? price *

                      (
                          1 -
                          botSettings.sl /
                          100
                      )

                    : price *

                      (
                          1 +
                          botSettings.sl /
                          100
                      ),

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

        console.log(e);
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

            const cp =
                coinData[p.symbol]
                    ?.live?.price;

            if (!cp)
                continue;

            const pnl =

                p.side === 'LONG'

                    ? (
                        (
                            (
                                cp -
                                p.avg
                            )

                            /

                            p.avg
                        ) * 100
                    )

                    : (
                        (
                            (
                                p.avg -
                                cp
                            )

                            /

                            p.avg
                        ) * 100
                    );

            const tp =
                p.side === 'LONG'
                    ? cp >= p.tp
                    : cp <= p.tp;

            const sl =
                p.side === 'LONG'
                    ? cp <= p.sl
                    : cp >= p.sl;

            const protect =

                p.dca > 0 &&

                (
                    p.side === 'LONG'

                        ? cp <=
                          p.avg * 0.99

                        : cp >=
                          p.avg * 1.01
                );

            // =====================
            // CLOSE
            // =====================
            if (
                tp ||
                sl ||
                protect
            ) {

                await exchange.createOrder(

                    toCCXTSymbol(
                        p.symbol
                    ),

                    'market',

                    p.side === 'LONG'
                        ? 'sell'
                        : 'buy',

                    p.qty,

                    undefined,

                    {
                        reduceOnly: true,
                        positionSide:
                            p.side
                    }
                );

                addLog(

                    `CLOSE ${pnl.toFixed(2)}%`,

                    p.symbol,

                    p.side
                );

                positions.delete(key);

                saveState();

                continue;
            }

            // =====================
            // DCA
            // =====================
            if (p.dca < 3) {

                const trigger =

                    p.side === 'LONG'

                        ? cp <=
                          p.entryInitial *

                          (
                              1 -
                              (
                                  botSettings.dcaPercent /
                                  100
                              ) *

                              (
                                  p.dca + 1
                              )
                          )

                        : cp >=
                          p.entryInitial *

                          (
                              1 +
                              (
                                  botSettings.dcaPercent /
                                  100
                              ) *

                              (
                                  p.dca + 1
                              )
                          );

                if (trigger) {

                    p.dca++;

                    const newQty =

                        (
                            botSettings.capital *
                            p.leverage
                        )

                        /

                        cp;

                    await exchange.createOrder(

                        toCCXTSymbol(
                            p.symbol
                        ),

                        'market',

                        p.side === 'LONG'
                            ? 'buy'
                            : 'sell',

                        newQty,

                        undefined,

                        {
                            positionSide:
                                p.side
                        }
                    );

                    p.avg =

                        (
                            (
                                p.avg *
                                p.qty
                            )

                            +

                            (
                                cp *
                                newQty
                            )
                        )

                        /

                        (
                            p.qty +
                            newQty
                        );

                    p.qty += newQty;

                    addLog(

                        `DCA ${p.dca}`,

                        p.symbol,

                        p.side
                    );

                    saveState();
                }
            }

        } catch (e) {

            addLog(
                `MONITOR ERROR ${e.message}`,
                p.symbol,
                p.side
            );
        }
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

        if (!botSettings.isRunning) {

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
// START
// =========================
app.listen(PORT, () => {

    console.log(
        `BOT RUNNING ${PORT}`
    );

    initWS();

    autoTradeLoop();

    monitorLoop();
});
