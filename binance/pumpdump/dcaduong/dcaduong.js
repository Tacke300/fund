import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

// ======================================================
// BINANCE
// ======================================================
const exchange = new ccxt.binance({

    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,

    options: {
        defaultType: 'future',
        hedgeMode: true,
        adjustForTimeDifference: true
    }
});

// ======================================================
// STATE
// ======================================================
let exchangeInfo = {};

let botSettings = {

    isRunning: false,

    capital: 5.5,
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

let currentBotIP = '0.0.0.0';

// ======================================================
// NO SPAM LOG
// ======================================================
let recentLogs = new Map();

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

        if (now - last < 15000)
            return;
    }

    recentLogs.set(key, now);

    setTimeout(() => {

        recentLogs.delete(key);

    }, 16000);

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
        status.botLogs.length > 150
    ) {

        status.botLogs.pop();
    }

    console.log(
        `[${time}] ${symbol} ${msg}`
    );
}

// ======================================================
// SAVE
// ======================================================
function saveState() {

    fs.writeFileSync(

        'config_data.json',

        JSON.stringify(
            botSettings,
            null,
            2
        )
    );
}

// ======================================================
// HELPERS
// ======================================================
function toCCXTSymbol(symbol) {

    return symbol
        .replace('USDT', '/USDT:USDT');
}

async function getMaxLeverage(symbol) {

    try {

        const res =
            await axios.get(

                'https://fapi.binance.com/fapi/v1/leverageBracket',

                {
                    headers: {
                        'X-MBX-APIKEY': API_KEY
                    }
                }
            );

        const item =
            res.data.find(
                x => x.symbol === symbol
            );

        if (!item)
            return 20;

        return item.brackets[0]
            ?.initialLeverage || 20;

    } catch {

        return 20;
    }
}

// ======================================================
// LOAD MARKETS
// ======================================================
async function loadExchangeInfo() {

    await exchange.loadMarkets();

    for (const [k, v]
        of Object.entries(
            exchange.markets
        )
    ) {

        exchangeInfo[k] = {

            minQty:
                v.limits.amount.min || 0,

            precision:
                v.precision.amount || 0
        };
    }

    addLog(
        'EXCHANGE READY'
    );
}

// ======================================================
// WALLET
// ======================================================
async function fetchWallet() {

    try {

        const balance =
            await exchange.fetchBalance();

        return {

            totalWalletBalance:
                (
                    balance.USDT?.total || 0
                ).toFixed(2),

            availableBalance:
                (
                    balance.USDT?.free || 0
                ).toFixed(2),

            totalUnrealizedProfit:
                (
                    balance.USDT?.unrealizedPnl || 0
                ).toFixed(2)
        };

    } catch {

        return {

            totalWalletBalance: '0.00',
            availableBalance: '0.00',
            totalUnrealizedProfit: '0.00'
        };
    }
}

// ======================================================
// CHANGE
// ======================================================
function calcChange(arr, min) {

    if (
        !arr ||
        arr.length < 2
    ) return 0;

    const now = Date.now();

    const old =
        arr.find(
            x =>
                x.t >=
                now - min * 60000
        ) || arr[0];

    return (
        (
            arr.at(-1).p - old.p
        ) / old.p
    ) * 100;
}

// ======================================================
// MARKET WS
// ======================================================
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
                .slice(0, 80)
                .map(
                    x =>
                        x.symbol.toLowerCase()
                );

        const ws = new WebSocket(

            `wss://fstream.binance.com/stream?streams=${
                symbols
                    .map(
                        s =>
                            `${s}@ticker`
                    )
                    .join('/')
            }`
        );

        ws.on('message', raw => {

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
                        .length > 5000
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
        });

        ws.on('open', () => {

            addLog(
                'WS CONNECTED'
            );
        });

        ws.on('close', () => {

            addLog(
                'WS RECONNECT'
            );

            setTimeout(
                initWS,
                3000
            );
        });

    } catch {

        setTimeout(
            initWS,
            3000
        );
    }
}

// ======================================================
// TP SL
// ======================================================
async function syncTPSL(
    pair,
    side,
    tp,
    sl
) {

    try {

        const sideClose =

            side === 'LONG'
                ? 'SELL'
                : 'BUY';

        try {

            const openOrders =
                await exchange.fetchOpenOrders(
                    pair
                );

            for (const o of openOrders) {

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

        tp =
            parseFloat(
                exchange.priceToPrecision(
                    pair,
                    tp
                )
            );

        sl =
            parseFloat(
                exchange.priceToPrecision(
                    pair,
                    sl
                )
            );

        await exchange.createOrder(

            pair,

            'TAKE_PROFIT_MARKET',

            sideClose,

            undefined,

            undefined,

            {

                positionSide: side,

                stopPrice: tp,

                closePosition: true,

                workingType:
                    'MARK_PRICE'
            }
        );

        await exchange.createOrder(

            pair,

            'STOP_MARKET',

            sideClose,

            undefined,

            undefined,

            {

                positionSide: side,

                stopPrice: sl,

                closePosition: true,

                workingType:
                    'MARK_PRICE'
            }
        );

    } catch (e) {

        addLog(
            `TPSL ERROR ${e.message}`
        );
    }
}

// ======================================================
// OPEN POSITION
// ======================================================
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

        const lev =
            await getMaxLeverage(
                symbol
            );

        let qty =
            (
                botSettings.capital *
                lev
            ) / price;

        qty = Math.max(
            qty,
            5.5 / price
        );

        qty =
            parseFloat(
                exchange.amountToPrecision(
                    pair,
                    qty
                )
            );

        await exchange.setLeverage(
            lev,
            pair
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

        const nextDca =

            side === 'LONG'

                ? price *
                  (
                      1 -
                      botSettings.dcaPercent / 100
                  )

                : price *
                  (
                      1 +
                      botSettings.dcaPercent / 100
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

            nextDca,

            margin:
                (
                    qty * price
                ) / lev,

            startTime:
                Date.now()
        });

        addLog(

            `OPEN ${lev}x | Margin:${(((qty * price) / lev)).toFixed(2)}$ | Entry:${price} | TP:${tp.toFixed(6)} | SL:${sl.toFixed(6)} | NextDCA:${nextDca.toFixed(6)}`,

            symbol,

            side
        );

    } catch (e) {

        addLog(
            `OPEN ERROR ${e.message}`,
            symbol,
            side
        );
    }
}

// ======================================================
// POSITION LOOP
// ======================================================
async function positionLoop() {

    try {

        const risk =
            await exchange.fetchPositions();

        risk.forEach(r => {

            const contracts =
                parseFloat(
                    r.contracts || 0
                );

            if (
                !contracts
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

            const pnl =
                parseFloat(
                    r.unrealizedPnl || 0
                );

            const margin =
                Math.abs(
                    parseFloat(
                        r.initialMargin || 0
                    )
                );

            const roi =
                margin > 0
                    ? (
                        pnl / margin
                    ) * 100
                    : 0;

            pos.pnl = roi;

            pos.unrealized = pnl;

            pos.markPrice =
                parseFloat(
                    r.markPrice || 0
                );

            pos.liquidationPrice =
                parseFloat(
                    r.liquidationPrice || 0
                );

            pos.nextDca =

                pos.side === 'LONG'

                    ? pos.entryInitial *

                      (
                          1 -
                          botSettings.dcaPercent / 100 *
                          (pos.dca + 1)
                      )

                    : pos.entryInitial *

                      (
                          1 +
                          botSettings.dcaPercent / 100 *
                          (pos.dca + 1)
                      );
        });

    } catch {}

    setTimeout(
        positionLoop,
        2000
    );
}

// ======================================================
// CLOSE POSITION
// ======================================================
async function closePosition(p) {

    try {

        const pair =
            toCCXTSymbol(
                p.symbol
            );

        await exchange.createOrder(

            pair,

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

            `CLOSE ROI:${p.pnl.toFixed(2)}% PNL:${p.unrealized.toFixed(2)}$`,

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

// ======================================================
// AUTO TRADE
// ======================================================
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

            if (
                !positions.has(
                    `${s}_${side}`
                )
            ) {

                addLog(

                    `TARGET M1:${c1.toFixed(2)} M5:${c5.toFixed(2)} M15:${c15.toFixed(2)}`,

                    s,

                    side
                );
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

// ======================================================
// API
// ======================================================
app.get(
    '/api/status',

    async (req, res) => {

        const wallet =
            await fetchWallet();

        const market =
            Object.entries(
                coinData
            )
            .map(([s, v]) => ({

                symbol: s,

                ...v.live
            }))
            .sort(
                (a, b) =>
                    Math.abs(
                        b.c1 || 0
                    ) -
                    Math.abs(
                        a.c1 || 0
                    )
            )
            .slice(0, 50);

        res.json({

            botIp:
                currentBotIP,

            wallet,

            market,

            activePositions:
                Array.from(
                    positions.values()
                ),

            botStatus:

                botSettings.isRunning
                    ? 'RUNNING'
                    : 'STOPPED',

            status
        });
    }
);

app.post(
    '/api/config',

    (req, res) => {

        botSettings = {

            ...botSettings,

            ...req.body
        };

        saveState();

        addLog(
            'CONFIG UPDATED'
        );

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

            const arr =
                Array.from(
                    positions.values()
                );

            for (const p of arr) {

                await closePosition(p);

                positions.delete(
                    `${p.symbol}_${p.side}`
                );
            }

            addLog(
                'CLOSE ALL DONE'
            );

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

// ======================================================
// INIT
// ======================================================
async function init() {

    try {

        const ip =
            await axios.get(
                'https://api.ipify.org?format=json'
            );

        currentBotIP =
            ip.data.ip;

        addLog(
            `IP ${currentBotIP}`
        );

    } catch {}

    await loadExchangeInfo();

    initWS();

    autoTradeLoop();

    positionLoop();

    addLog(
        'SYSTEM READY'
    );
}

app.listen(PORT, async () => {

    console.log(
        `BOT RUNNING ${PORT}`
    );

    await init();
});
