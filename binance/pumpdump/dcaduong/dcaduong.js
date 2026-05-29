import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import crypto from 'crypto';
import ccxt from 'ccxt';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    timeout: 15000,
    headers: {
        'X-MBX-APIKEY': API_KEY
    }
});

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'future',
        dualSidePosition: true,
        recvWindow: 60000
    }
});

let timestampOffset = 0;

let botSettings = {
    isRunning: false,
    capital: 5.5,
    volVolatility: 6.5,
    maxPos: 3,
    maxDca: 3,
    dcaPercent: 10,
    tp: 0.5,
    sl: 10
};

let coinData = {};

let positions = new Map();

let status = {
    botLogs: [],
    botClosedCount: 0,
    totalClosedPnL: 0,
    totalDcaClosed: 0
};

function addLog(msg) {

    status.botLogs.unshift({
        time: new Date().toLocaleTimeString('vi-VN', {
            hour12: false
        }),
        msg
    });

    if (status.botLogs.length > 300) {
        status.botLogs.pop();
    }

    console.log(msg);
}

function getIP() {

    const interfaces = os.networkInterfaces();

    for (const name in interfaces) {

        for (const net of interfaces[name]) {

            if (
                net.family === 'IPv4' &&
                !net.internal
            ) {

                if (
                    net.address !== '127.0.0.1'
                ) {

                    return net.address;
                }
            }
        }
    }

    return 'NO-IP';
}

async function binancePrivate(
    endpoint,
    method = 'GET',
    data = {}
) {

    try {

        const timestamp =
            Date.now() + timestampOffset;

        const query =
            new URLSearchParams({
                ...data,
                timestamp,
                recvWindow: 60000
            }).toString();

        const signature =
            crypto
            .createHmac(
                'sha256',
                SECRET_KEY
            )
            .update(query)
            .digest('hex');

        const res =
            await binanceApi({
                method,
                url:
                    `${endpoint}?${query}&signature=${signature}`
            });

        return res.data;

    } catch (e) {

        if (
            e.response?.data?.code === -1021
        ) {

            const t =
                await axios.get(
                    'https://fapi.binance.com/fapi/v1/time'
                );

            timestampOffset =
                t.data.serverTime - Date.now();

            return binancePrivate(
                endpoint,
                method,
                data
            );
        }

        throw e;
    }
}

function calculateChange(pArr, min) {

    if (!pArr || pArr.length < 2) {
        return 0;
    }

    const now = Date.now();

    let start =
        pArr.find(i =>
            i.t >= (
                now - min * 60000
            )
        ) || pArr[0];

    return parseFloat(
        (
            (
                (
                    pArr[pArr.length - 1].p -
                    start.p
                ) / start.p
            ) * 100
        ).toFixed(2)
    );
}

async function bootstrapData() {

    console.log(
        'BOOTSTRAP DATA...'
    );

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const tickers =
            res.data;

        const usdtPairs =
            tickers.filter(t =>
                t.symbol.endsWith('USDT')
            );

        for (const t of usdtPairs) {

            try {

                const kRes =
                    await axios.get(
                        `https://fapi.binance.com/fapi/v1/klines?symbol=${t.symbol}&interval=1m&limit=20`
                    );

                const kData =
                    kRes.data;

                if (!coinData[t.symbol]) {

                    coinData[t.symbol] = {

                        symbol:t.symbol,
                        prices:[]
                    };
                }

                coinData[t.symbol].prices =
                    kData.map(k => ({

                        p:parseFloat(k[4]),
                        t:parseInt(k[0])

                    }));

            } catch {}
        }

        console.log(
            'BOOTSTRAP DONE'
        );

    } catch(e) {

        console.log(
            e.message
        );
    }
}

function updatePriceLogic(
    symbol,
    price,
    now
) {

    if (!coinData[symbol]) {

        coinData[symbol] = {

            symbol,
            prices:[]
        };
    }

    coinData[symbol].price = price;

    coinData[symbol].prices.push({

        p:price,
        t:now
    });

    if (
        coinData[symbol].prices.length >
        1200
    ) {

        coinData[symbol].prices.shift();
    }

    const c1 =
        calculateChange(
            coinData[symbol].prices,
            1
        );

    const c5 =
        calculateChange(
            coinData[symbol].prices,
            5
        );

    const c15 =
        calculateChange(
            coinData[symbol].prices,
            15
        );

    coinData[symbol].live = {

        c1,
        c5,
        c15,
        currentPrice:price
    };
}

async function initWS() {

    const res =
        await axios.get(
            'https://fapi.binance.com/fapi/v1/ticker/price'
        );

    const tickers =
        res.data;

    const symbols =
        tickers
        .filter(t =>
            t.symbol.endsWith('USDT')
        )
        .map(t =>
            t.symbol.toLowerCase()
        );

    const chunkSize = 50;

    for (
        let i = 0;
        i < symbols.length;
        i += chunkSize
    ) {

        const chunk =
            symbols.slice(
                i,
                i + chunkSize
            );

        const streamString =
            chunk
            .map(s =>
                `${s}@ticker`
            )
            .join('/');

        const ws =
            new WebSocket(
                `wss://fstream.binance.com/stream?streams=${streamString}`
            );

        ws.on(
            'message',
            raw => {

                try {

                    const msg =
                        JSON.parse(raw);

                    if (!msg.data) {
                        return;
                    }

                    updatePriceLogic(

                        msg.data.s,

                        parseFloat(
                            msg.data.c
                        ),

                        Date.now()
                    );

                } catch {}
            }
        );

        ws.on(
            'close',
            () => {

                setTimeout(
                    initWS,
                    1000
                );
            }
        );

        ws.on(
            'error',
            () => {}
        );
    }
}

async function fallbackAPI() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const data =
            res.data;

        const now =
            Date.now();

        data.forEach(t => {

            if (
                t.symbol.endsWith('USDT')
            ) {

                updatePriceLogic(

                    t.symbol,

                    parseFloat(
                        t.price
                    ),

                    now
                );
            }
        });

    } catch {}

    setTimeout(
        fallbackAPI,
        1000
    );
}

async function openPosition(
    symbol,
    side,
    currentPrice,
    isDca = false
) {

    try {

        const key =
            `${symbol}_${side}`;

        if (
            positions.has(key) &&
            !isDca
        ) {
            return;
        }

        const lev = 20;

        const margin =
            Math.max(
                parseFloat(
                    botSettings.capital
                ),
                5.5
            );

        const qty =
            (
                margin *
                lev
            ) / currentPrice;

        await exchange.setLeverage(
            lev,
            symbol
        );

        await exchange.createOrder(
            symbol,
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

        let entry = currentPrice;

        try {

            const pos =
                await binancePrivate(
                    '/fapi/v2/positionRisk'
                );

            const real =
                pos.find(p =>
                    p.symbol === symbol &&
                    p.positionSide === side &&
                    Math.abs(
                        parseFloat(
                            p.positionAmt
                        )
                    ) > 0
                );

            if (real) {

                entry =
                    parseFloat(
                        real.entryPrice
                    );
            }

        } catch {}

        if (!positions.has(key)) {

            positions.set(key, {

                symbol,
                side,
                lev,
                margin,
                qty,

                entry,
                avg: entry,

                tp:
                    side === 'LONG'
                    ? entry *
                        (
                            1 +
                            botSettings.tp / 100
                        )
                    : entry *
                        (
                            1 -
                            botSettings.tp / 100
                        ),

                sl:
                    side === 'LONG'
                    ? entry *
                        (
                            1 -
                            botSettings.sl / 100
                        )
                    : entry *
                        (
                            1 +
                            botSettings.sl / 100
                        ),

                nextDca:
                    side === 'LONG'
                    ? entry *
                        (
                            1 +
                            botSettings.dcaPercent / 100
                        )
                    : entry *
                        (
                            1 -
                            botSettings.dcaPercent / 100
                        ),

                dca: 0,
                didDca: false
            });

        } else {

            const p =
                positions.get(key);

            p.didDca = true;

            p.dca++;

            p.margin += margin;

            p.qty += qty;

            p.avg =
                (
                    (
                        p.avg *
                        (p.qty - qty)
                    ) +
                    (
                        currentPrice * qty
                    )
                ) / p.qty;

            p.tp =
                p.side === 'LONG'
                ? p.avg *
                    (
                        1 +
                        botSettings.tp / 100
                    )
                : p.avg *
                    (
                        1 -
                        botSettings.tp / 100
                    );

            p.sl =
                p.side === 'LONG'
                ? p.avg *
                    (
                        1 -
                        botSettings.sl / 100
                    )
                : p.avg *
                    (
                        1 +
                        botSettings.sl / 100
                    );

            p.nextDca =
                p.side === 'LONG'
                ? currentPrice *
                    (
                        1 +
                        botSettings.dcaPercent / 100
                    )
                : currentPrice *
                    (
                        1 -
                        botSettings.dcaPercent / 100
                    );

            addLog(
                `💵 DCA ${symbol} ${side} | Margin:${margin.toFixed(2)} | Qty:${qty.toFixed(4)} | Entry:${currentPrice.toFixed(6)} | AVG:${p.avg.toFixed(6)} | NextDCA:${p.nextDca.toFixed(6)}`
            );

            return;
        }

        const p =
            positions.get(key);

        addLog(
            `📌 OPEN ${symbol} ${side} | Margin:${margin.toFixed(2)} | Qty:${qty.toFixed(4)} | Lev:${lev}x | Entry:${entry.toFixed(6)} | TP:${p.tp.toFixed(6)} | SL:${p.sl.toFixed(6)} | NextDCA:${p.nextDca.toFixed(6)} | AVG:${p.avg.toFixed(6)}`
        );

    } catch (e) {

        addLog(
            `⛔ OPEN ERROR ${symbol} ${e.message}`
        );
    }
}

async function closePosition(
    key,
    reason,
    currentPrice
) {

    try {

        const p =
            positions.get(key);

        if (!p) {
            return;
        }

        await exchange.createOrder(
            p.symbol,
            'market',
            p.side === 'LONG'
                ? 'sell'
                : 'buy',
            p.qty,
            undefined,
            {
                reduceOnly: true,
                positionSide: p.side
            }
        );

        const pnl =
            (
                p.side === 'LONG'
                ?
                (
                    (
                        currentPrice - p.avg
                    ) / p.avg
                )
                :
                (
                    (
                        p.avg - currentPrice
                    ) / p.avg
                )
            ) * 100 * p.lev - 0.1;

        status.totalClosedPnL += pnl;
        status.botClosedCount++;

        if (p.didDca) {
            status.totalDcaClosed++;
        }

        if (reason === 'TP') {

            addLog(
                `💲 TP ${p.symbol} | PNL:${pnl.toFixed(2)}% | Exit:${currentPrice.toFixed(6)}`
            );

        } else if (reason === 'SL') {

            addLog(
                `😭 SL ${p.symbol} | PNL:${pnl.toFixed(2)}% | Exit:${currentPrice.toFixed(6)}`
            );

        } else {

            addLog(
                `💲 AVG CLOSE ${p.symbol} | PNL:${pnl.toFixed(2)}% | Exit:${currentPrice.toFixed(6)}`
            );
        }

        positions.delete(key);

    } catch (e) {

        addLog(
            `⛔ CLOSE ERROR ${e.message}`
        );
    }
}

async function autoTradeLoop() {

    try {

        if (!botSettings.isRunning) {

            setTimeout(
                autoTradeLoop,
                1000
            );

            return;
        }

        if (
            positions.size >=
            botSettings.maxPos
        ) {

            setTimeout(
                autoTradeLoop,
                1000
            );

            return;
        }

        const market =

            Object.entries(coinData)

            .filter(([,v]) =>
                v.live
            )

            .map(([s,v]) => ({

                symbol:s,

                price:
                    v.live.currentPrice,

                c1:v.live.c1,

                c5:v.live.c5,

                c15:v.live.c15,

                vol:Math.max(
                    Math.abs(v.live.c1),
                    Math.abs(v.live.c5),
                    Math.abs(v.live.c15)
                )

            }))

            .sort((a,b)=>
                b.vol-a.vol
            );

        const best = market[0];

        if (
            best &&
            best.vol >=
            botSettings.volVolatility
        ) {

            const side =
                (
                    best.c1 +
                    best.c5 +
                    best.c15
                ) >= 0
                ? 'LONG'
                : 'SHORT';

            const key =
                `${best.symbol}_${side}`;

            if (
                !positions.has(key)
            ) {

                await openPosition(
                    best.symbol,
                    side,
                    best.price
                );
            }
        }

    } catch (e) {

        addLog(
            `⛔ LOOP ERROR ${e.message}`
        );
    }

    setTimeout(
        autoTradeLoop,
        1000
    );
}

async function monitorLoop() {

    try {

        for (
            const [key,p]
            of positions
        ) {

            const currentPrice =
                coinData[
                    p.symbol
                ]?.live?.currentPrice;

            if (!currentPrice) {
                continue;
            }

            const pnl =
                (
                    p.side === 'LONG'
                    ?
                    (
                        (
                            currentPrice - p.avg
                        ) / p.avg
                    )
                    :
                    (
                        (
                            p.avg - currentPrice
                        ) / p.avg
                    )
                ) * 100 * p.lev;

            p.pnl = pnl;

            p.currentPrice = currentPrice;

            if (p.side === 'LONG') {

                if (
                    currentPrice >= p.tp
                ) {

                    await closePosition(
                        key,
                        'TP',
                        currentPrice
                    );

                    continue;
                }

                if (
                    currentPrice <= p.sl
                ) {

                    await closePosition(
                        key,
                        'SL',
                        currentPrice
                    );

                    continue;
                }

            } else {

                if (
                    currentPrice <= p.tp
                ) {

                    await closePosition(
                        key,
                        'TP',
                        currentPrice
                    );

                    continue;
                }

                if (
                    currentPrice >= p.sl
                ) {

                    await closePosition(
                        key,
                        'SL',
                        currentPrice
                    );

                    continue;
                }
            }

            if (
                p.dca <
                botSettings.maxDca
            ) {

                const hitDca =
                    p.side === 'LONG'
                    ? currentPrice >=
                        p.nextDca
                    : currentPrice <=
                        p.nextDca;

                if (hitDca) {

                    await openPosition(
                        p.symbol,
                        p.side,
                        currentPrice,
                        true
                    );
                }
            }

            const avgClose =
                p.side === 'LONG'
                ? currentPrice >=
                    p.avg * 1.01
                : currentPrice <=
                    p.avg * 0.99;

            if (
                p.didDca &&
                avgClose
            ) {

                await closePosition(
                    key,
                    'AVG',
                    currentPrice
                );
            }
        }

    } catch (e) {

        addLog(
            `⛔ MONITOR ERROR ${e.message}`
        );
    }

    setTimeout(
        monitorLoop,
        1000
    );
}

app.post(
    '/api/start',
    (req,res) => {

        botSettings.isRunning = true;

        addLog(
            '🚀 BOT START'
        );

        res.json({
            ok:true
        });
    }
);

app.post(
    '/api/stop',
    (req,res) => {

        botSettings.isRunning = false;

        addLog(
            '⛔ BOT STOP'
        );

        res.json({
            ok:true
        });
    }
);

app.post(
    '/api/closeall',
    async (req,res) => {

        try {

            for (
                const [key,p]
                of positions
            ) {

                await exchange.createOrder(
                    p.symbol,
                    'market',
                    p.side === 'LONG'
                        ? 'sell'
                        : 'buy',
                    p.qty,
                    undefined,
                    {
                        reduceOnly:true,
                        positionSide:p.side
                    }
                );
            }

            positions.clear();

            addLog(
                '⚠️ CLOSE ALL'
            );

        } catch(e) {

            addLog(
                `⛔ CLOSEALL ERROR ${e.message}`
            );
        }

        res.json({
            ok:true
        });
    }
);

app.get(
    '/api/status',
    async (req,res) => {

        let wallet = {
            totalWalletBalance:'0.00',
            availableBalance:'0.00',
            totalUnrealizedProfit:'0.00'
        };

        try {

            const acc =
                await binancePrivate(
                    '/fapi/v2/account'
                );

            wallet = {

                totalWalletBalance:
                    parseFloat(
                        acc.totalWalletBalance || 0
                    ).toFixed(2),

                availableBalance:
                    parseFloat(
                        acc.availableBalance || 0
                    ).toFixed(2),

                totalUnrealizedProfit:
                    parseFloat(
                        acc.totalUnrealizedProfit || 0
                    ).toFixed(2)
            };

        } catch {}

        const market =

            Object.entries(coinData)

            .filter(([,v]) =>
                v.live
            )

            .map(([s,v]) => ({

                symbol:s,

                price:
                    v.live.currentPrice,

                c1:v.live.c1,

                c5:v.live.c5,

                c15:v.live.c15,

                vol:Math.max(
                    Math.abs(v.live.c1),
                    Math.abs(v.live.c5),
                    Math.abs(v.live.c15)
                )

            }))

            .sort((a,b)=>
                b.vol-a.vol
            )

            .slice(0,30);

        res.json({

            botIp:getIP(),

            wallet,

            market,

            activePositions:
                Array.from(
                    positions.values()
                ),

            status
        });
    }
);

app.listen(
    PORT,
    async () => {

        console.log(
            `BOT RUNNING ${PORT}`
        );

        addLog(
            '🚀 SYSTEM READY'
        );

        await bootstrapData();

        initWS();

        fallbackAPI();

        autoTradeLoop();

        monitorLoop();
    }
);
