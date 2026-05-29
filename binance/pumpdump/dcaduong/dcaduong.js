import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import ccxt from 'ccxt';
import WebSocket from 'ws';

import {
    API_KEY,
    SECRET_KEY
} from './config.js';

// ============================================================================
// CONFIG
// ============================================================================

const PORT = 1114;

const __filename =
    fileURLToPath(import.meta.url);

const __dirname =
    path.dirname(__filename);

const CONFIG_FILE =
    path.join(__dirname, 'bot_config.json');

// ============================================================================
// EXPRESS
// ============================================================================

const APP = express();

APP.use(express.json());

APP.use(express.static(__dirname));

// ============================================================================
// BINANCE
// ============================================================================

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

        recvWindow: 60000,

        adjustForTimeDifference: true
    }
});

// ============================================================================
// SETTINGS
// ============================================================================

let botSettings = {

    isRunning: false,

    capital: '1%',

    volVolatility: 6.5,

    maxPos: 3,

    maxDca: 2,

    dcaPercent: 10,

    tp: 0.5,

    sl: 10
};

if (fs.existsSync(CONFIG_FILE)) {

    try {

        botSettings = {

            ...botSettings,

            ...JSON.parse(
                fs.readFileSync(CONFIG_FILE, 'utf8')
            )
        };

    } catch (e) {

        console.log(e.message);
    }
}

// ============================================================================
// GLOBAL
// ============================================================================

let timestampOffset = 0;

let currentBotIP = null;

let botActivePositions = new Map();

let isProcessingDCA = new Set();

let coinData = {};

let status = {

    botLogs: [],

    candidatesList: [],

    blackList: {},

    botClosedCount: 0,

    botPnLClosed: 0,

    exchangeInfo: {},

    isReady: false
};

// ============================================================================
// LOG
// ============================================================================

function addBotLog(msg, type = 'info') {

    const time =
        new Date().toLocaleTimeString(
            'vi-VN',
            { hour12: false }
        );

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

// ============================================================================
// PRIVATE API
// ============================================================================

async function binancePrivate(

    endpoint,

    method = 'GET',

    data = {}
) {

    try {

        const timestamp =
            Date.now() + timestampOffset;

        const queryStr =
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
                .update(queryStr)
                .digest('hex');

        const response =
            await binanceApi({

                method,

                url:
                    `${endpoint}?${queryStr}&signature=${signature}`
            });

        return response.data;

    } catch (e) {

        if (e.response?.data?.code === -1021) {

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

// ============================================================================
// VOLATILITY ENGINE
// ============================================================================

function calculateChange(pArr, min) {

    if (!pArr || pArr.length < 2) {
        return 0;
    }

    const now = Date.now();

    let start =

        pArr.find(i =>
            i.t >= (now - min * 60000)
        )

        ||

        pArr[0];

    return parseFloat(

        (
            (
                (pArr[pArr.length - 1].p - start.p)

                / start.p
            )

            * 100
        ).toFixed(2)
    );
}

function updatePriceLogic(symbol, price, now) {

    if (!coinData[symbol]) {

        coinData[symbol] = {

            symbol,

            prices: []
        };
    }

    coinData[symbol].prices.push({

        p: price,

        t: now
    });

    if (coinData[symbol].prices.length > 1200) {

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

        currentPrice: price
    };
}

// ============================================================================
// WEBSOCKET
// ============================================================================

function createWS(streamString) {

    const ws = new WebSocket(

        `wss://fstream.binance.com/stream?streams=${streamString}`
    );

    ws.on('open', () => {

        addBotLog(
            `✅ WS CONNECTED`
        );
    });

    ws.on('message', raw => {

        try {

            const msg =
                JSON.parse(raw);

            if (msg.data) {

                updatePriceLogic(

                    msg.data.s,

                    parseFloat(msg.data.c),

                    Date.now()
                );
            }

        } catch (e) {}
    });

    ws.on('close', () => {

        addBotLog(
            `⚠️ WS RECONNECT`,
            'error'
        );

        setTimeout(() => {

            createWS(streamString);

        }, 1000);
    });

    ws.on('error', () => {});
}

async function initWS() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const symbols =

            res.data

                .filter(t =>

                    t.symbol.endsWith('USDT')
                )

                .map(t =>

                    t.symbol.toLowerCase()
                );

        addBotLog(
            `📡 Loading ${symbols.length} symbols`
        );

        const chunkSize = 70;

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

                chunk.map(s =>
                    `${s}@ticker`
                ).join('/');

            createWS(streamString);
        }

    } catch (e) {

        addBotLog(
            `WS INIT ERROR ${e.message}`,
            'error'
        );
    }
}

// ============================================================================
// FALLBACK
// ============================================================================

async function fallbackAPI() {

    try {

        const res =
            await axios.get(
                'https://fapi.binance.com/fapi/v1/ticker/price'
            );

        const now = Date.now();

        res.data.forEach(t => {

            if (
                t.symbol.endsWith('USDT')
            ) {

                updatePriceLogic(

                    t.symbol,

                    parseFloat(t.price),

                    now
                );
            }
        });

    } catch (e) {}

    setTimeout(
        fallbackAPI,
        1000
    );
}

// ============================================================================
// CANDIDATES
// ============================================================================

function updateCandidates() {

    try {

        const topData =

            Object.entries(coinData)

                .filter(([, v]) =>
                    v.live
                )

                .map(([s, v]) => ({

                    symbol: s,

                    ...v.live,

                    score:

                        Math.abs(v.live.c1)

                        +

                        Math.abs(v.live.c5)

                        +

                        Math.abs(v.live.c15)
                }))

                .sort((a, b) =>
                    b.score - a.score
                )

                .slice(0, 50);

        status.candidatesList = topData;

    } catch (e) {}

    setTimeout(
        updateCandidates,
        1000
    );
}

// ============================================================================
// OPEN POSITION
// ============================================================================

async function openPosition(

    symbol,

    dcaData = null,

    triggerSide = 'LONG'
) {

    if (isProcessingDCA.has(symbol)) {
        return;
    }

    isProcessingDCA.add(symbol);

    try {

        const info =
            status.exchangeInfo[symbol];

        if (!info) return;

        const ticker =
            (
                await binanceApi.get(
                    `/fapi/v1/ticker/price?symbol=${symbol}`
                )
            ).data;

        const currentPrice =
            parseFloat(ticker.price);

        let qty;
        let margin;

        if (dcaData) {

            margin =

                dcaData.firstMargin

                *

                Math.pow(
                    2,
                    dcaData.dcaCount + 1
                );

            qty =

                Math.ceil(

                    (
                        (
                            margin
                            *
                            info.maxLeverage
                        )

                        / currentPrice
                    )

                    / info.stepSize

                )

                * info.stepSize;

        } else {

            const acc =
                await binancePrivate(
                    '/fapi/v2/account'
                );

            let capital =

                botSettings.capital.includes('%')

                    ?

                    (
                        parseFloat(
                            acc.availableBalance
                        )

                        *

                        parseFloat(
                            botSettings.capital
                        )

                        / 100
                    )

                    :

                    parseFloat(
                        botSettings.capital
                    );

            qty =

                Math.ceil(

                    (
                        (
                            capital
                            *
                            info.maxLeverage
                        )

                        / currentPrice
                    )

                    / info.stepSize

                )

                * info.stepSize;

            margin = capital;
        }

        if (qty <= 0) return;

        await exchange.setLeverage(
            info.maxLeverage,
            symbol
        );

        const finalSide =

            dcaData
                ? dcaData.side
                : triggerSide;

        await exchange.createOrder(

            symbol,

            'MARKET',

            finalSide === 'SHORT'
                ? 'SELL'
                : 'BUY',

            qty.toFixed(
                info.quantityPrecision
            ),

            undefined,

            {
                positionSide: finalSide
            }
        );

        await new Promise(r =>
            setTimeout(r, 1000)
        );

        const p =

            (
                await binancePrivate(

                    '/fapi/v2/positionRisk',

                    'GET',

                    { symbol }
                )
            )

            .find(x =>

                x.positionSide === finalSide

                &&

                Math.abs(
                    parseFloat(x.positionAmt)
                ) > 0
            );

        if (!p) return;

        const entry =
            parseFloat(p.entryPrice);

        botActivePositions.set(

            `${symbol}_${finalSide}`,

            {

                symbol,

                side: finalSide,

                firstEntry:

                    dcaData
                        ? dcaData.firstEntry
                        : entry,

                dcaCount:

                    dcaData
                        ? dcaData.dcaCount + 1
                        : 0,

                firstMargin:

                    dcaData
                        ? dcaData.firstMargin
                        : margin,

                avgEntryPrice: entry,

                currentROI: 0
            }
        );

        addBotLog(

`📈 OPEN ${symbol}

SIDE: ${finalSide}

ENTRY: ${entry}

MARK: ${currentPrice}

QTY: ${qty}

LEV: ${info.maxLeverage}x

DCA: ${dcaData ? dcaData.dcaCount + 1 : 0}

MARGIN: ${margin.toFixed(2)}`
        );

    } catch (e) {

        addBotLog(

            `OPEN ERROR ${e.message}`,

            'error'
        );
    }

    finally {

        setTimeout(() => {

            isProcessingDCA.delete(symbol);

        }, 2000);
    }
}

// ============================================================================
// CLOSE
// ============================================================================

async function closePositionMarket(

    symbol,

    side,

    qty
) {

    try {

        const sideToClose =

            side === 'LONG'
                ? 'SELL'
                : 'BUY';

        await binancePrivate(

            '/fapi/v1/order',

            'POST',

            {

                symbol,

                side: sideToClose,

                positionSide: side,

                type: 'MARKET',

                quantity: qty
            }
        );

        await binancePrivate(

            '/fapi/v1/allOpenOrders',

            'DELETE',

            { symbol }
        );

        botActivePositions.delete(
            `${symbol}_${side}`
        );

        status.blackList[symbol] =

            Date.now()
            +
            (15 * 60 * 1000);

        status.botClosedCount++;

    } catch (e) {

        addBotLog(

            `CLOSE ERROR ${e.message}`,

            'error'
        );
    }

    finally {

        setTimeout(() => {

            isProcessingDCA.delete(symbol);

        }, 2000);
    }
}

// ============================================================================
// MONITOR
// ============================================================================

async function priceMonitor() {

    if (!status.isReady) {

        return setTimeout(
            priceMonitor,
            1000
        );
    }

    try {

        const posRisk =
            await binancePrivate(
                '/fapi/v2/positionRisk'
            );

        for (let [key, b] of botActivePositions) {

            const realP =

                posRisk.find(p =>

                    `${p.symbol}_${p.positionSide}` === key

                    &&

                    Math.abs(
                        parseFloat(p.positionAmt)
                    ) > 0
                );

            if (!realP) {

                botActivePositions.delete(key);

                continue;
            }

            const markP =
                parseFloat(realP.markPrice);

            const avgEntry =
                parseFloat(realP.entryPrice);

            const qty =
                Math.abs(
                    parseFloat(realP.positionAmt)
                );

            const lev =
                parseFloat(
                    realP.leverage || 20
                );

            b.priceDev =

                (
                    (
                        markP - b.firstEntry
                    )

                    / b.firstEntry
                ) * 100;

            const diffPercent =

                b.side === 'LONG'

                    ?

                    (
                        (
                            markP - avgEntry
                        )

                        / avgEntry
                    ) * 100

                    :

                    (
                        (
                            avgEntry - markP
                        )

                        / avgEntry
                    ) * 100;

            const roi =
                diffPercent * lev;

            b.currentROI = roi;

            // =====================================================
            // TP
            // =====================================================

            if (

                b.dcaCount === 0

                &&

                roi >= botSettings.tp

            ) {

                addBotLog(

`💰 TAKE PROFIT

${b.symbol}

SIDE: ${b.side}

ROI: ${roi.toFixed(2)}%

AVG: ${avgEntry}

MARK: ${markP}

DCA: ${b.dcaCount}`
                );

                await closePositionMarket(

                    b.symbol,

                    b.side,

                    qty
                );

                continue;
            }

            // =====================================================
            // SL
            // =====================================================

            if (
                roi <= -botSettings.sl
            ) {

                addBotLog(

`🛑 STOP LOSS

${b.symbol}

SIDE: ${b.side}

ROI: ${roi.toFixed(2)}%

AVG: ${avgEntry}

MARK: ${markP}`
                );

                await closePositionMarket(

                    b.symbol,

                    b.side,

                    qty
                );

                continue;
            }

            // =====================================================
            // AVG +1%
            // =====================================================

            if (

                b.dcaCount > 0

                &&

                !isProcessingDCA.has(b.symbol)

            ) {

                const target =

                    b.side === 'LONG'

                        ?

                        avgEntry * 1.01

                        :

                        avgEntry * 0.99;

                const hit =

                    (

                        b.side === 'LONG'

                        &&

                        markP >= target
                    )

                    ||

                    (

                        b.side === 'SHORT'

                        &&

                        markP <= target
                    );

                if (hit) {

                    isProcessingDCA.add(
                        b.symbol
                    );

                    addBotLog(

`✅ AVG CLOSE

${b.symbol}

SIDE: ${b.side}

AVG: ${avgEntry}

MARK: ${markP}

ROI: ${roi.toFixed(2)}%

DCA: ${b.dcaCount}`
                    );

                    await closePositionMarket(

                        b.symbol,

                        b.side,

                        qty
                    );

                    continue;
                }
            }

            // =====================================================
            // DCA
            // =====================================================

            if (

                b.dcaCount < botSettings.maxDca

                &&

                !isProcessingDCA.has(b.symbol)

            ) {

                const trigger =

                    (
                        b.dcaCount + 1
                    )

                    *

                    botSettings.dcaPercent;

                const needDCA =

                    (

                        b.side === 'LONG'

                        &&

                        b.priceDev >= trigger
                    )

                    ||

                    (

                        b.side === 'SHORT'

                        &&

                        b.priceDev <= -trigger
                    );

                if (needDCA) {

                    addBotLog(

`📈 DCA OPEN

${b.symbol}

SIDE: ${b.side}

LEVEL: ${b.dcaCount + 1}

PRICE: ${markP}

AVG: ${avgEntry}`
                    );

                    await openPosition(

                        b.symbol,

                        { ...b },

                        b.side
                    );
                }
            }
        }

    } catch (e) {

        addBotLog(

            `MONITOR ERROR ${e.message}`,

            'error'
        );
    }

    setTimeout(
        priceMonitor,
        1000
    );
}

// ============================================================================
// AUTO TRADE
// ============================================================================

async function autoTradeLoop() {

    if (!botSettings.isRunning) {

        return setTimeout(
            autoTradeLoop,
            1000
        );
    }

    try {

        if (
            botActivePositions.size >=
            botSettings.maxPos
        ) {

            return setTimeout(
                autoTradeLoop,
                1000
            );
        }

        for (const c of status.candidatesList) {

            const symbol = c.symbol;

            if (

                status.blackList[symbol]

                &&

                Date.now()
                <
                status.blackList[symbol]

            ) continue;

            if (

                botActivePositions.has(
                    `${symbol}_LONG`
                )

                ||

                botActivePositions.has(
                    `${symbol}_SHORT`
                )

            ) continue;

            const maxVol = Math.max(

                Math.abs(c.c1),

                Math.abs(c.c5),

                Math.abs(c.c15)
            );

            if (
                maxVol <
                botSettings.volVolatility
            ) continue;

            const sumVol =
                c.c1 + c.c5 + c.c15;

            const side =

                sumVol >= 0

                    ? 'LONG'

                    : 'SHORT';

            addBotLog(
                `🔥 SIGNAL ${symbol} ${side}`
            );

            await openPosition(
                symbol,
                null,
                side
            );

            break;
        }

    } catch (e) {

        addBotLog(

            `TRADE LOOP ERROR ${e.message}`,

            'error'
        );
    }

    setTimeout(
        autoTradeLoop,
        1000
    );
}

// ============================================================================
// API STATUS
// ============================================================================

APP.get('/api/status', async (req, res) => {

    try {

        let wallet = {

            totalWalletBalance: '0.00',

            availableBalance: '0.00',

            totalUnrealizedProfit: '0.00'
        };

        try {

            const acc =
                await binancePrivate(
                    '/fapi/v2/account'
                );

            wallet = {

                totalWalletBalance:

                    parseFloat(
                        acc.totalWalletBalance
                    ).toFixed(2),

                availableBalance:

                    parseFloat(
                        acc.availableBalance
                    ).toFixed(2),

                totalUnrealizedProfit:

                    parseFloat(
                        acc.totalUnrealizedProfit
                    ).toFixed(2)
            };

        } catch (e) {}

        res.json({

            wallet,

            activePositions:

                Array.from(
                    botActivePositions.values()
                ),

            status
        });

    } catch (e) {

        res.status(500).json({

            error: e.message
        });
    }
});

// ============================================================================
// SETTINGS
// ============================================================================

APP.post('/api/settings', (req, res) => {

    botSettings = {

        ...botSettings,

        ...req.body
    };

    fs.writeFileSync(

        CONFIG_FILE,

        JSON.stringify(
            botSettings,
            null,
            2
        )
    );

    addBotLog(
        '⚙️ SETTINGS SAVED'
    );

    res.json({
        success: true
    });
});

// ============================================================================
// START
// ============================================================================

APP.post('/api/start', (req, res) => {

    botSettings.isRunning = true;

    addBotLog('🚀 BOT STARTED');

    res.json({
        success: true
    });
});

// ============================================================================
// STOP
// ============================================================================

APP.post('/api/stop', (req, res) => {

    botSettings.isRunning = false;

    addBotLog('⛔ BOT STOPPED');

    res.json({
        success: true
    });
});

// ============================================================================
// PANIC CLOSE
// ============================================================================

APP.post('/api/panic-close', async (req, res) => {

    try {

        const positions =
            await binancePrivate(
                '/fapi/v2/positionRisk'
            );

        for (const p of positions) {

            const amt =
                parseFloat(
                    p.positionAmt
                );

            if (amt === 0) continue;

            const qty =
                Math.abs(amt);

            await binancePrivate(

                '/fapi/v1/order',

                'POST',

                {

                    symbol: p.symbol,

                    side:

                        amt > 0
                            ? 'SELL'
                            : 'BUY',

                    positionSide:
                        p.positionSide,

                    type: 'MARKET',

                    quantity: qty
                }
            );

            addBotLog(
                `⚠️ PANIC ${p.symbol}`
            );
        }

        botActivePositions.clear();

        res.json({
            success: true
        });

    } catch (e) {

        res.status(500).json({

            error: e.message
        });
    }
});

// ============================================================================
// INIT
// ============================================================================

async function init() {

    try {

        addBotLog(
            'Loading exchange info...'
        );

        const info =
            await binanceApi.get(
                '/fapi/v1/exchangeInfo'
            );

        const temp = {};

        info.data.symbols.forEach(s => {

            const lotFilter =
                s.filters.find(

                    f =>
                        f.filterType === 'LOT_SIZE'
                );

            temp[s.symbol] = {

                quantityPrecision:
                    s.quantityPrecision,

                stepSize:
                    parseFloat(
                        lotFilter.stepSize
                    ),

                maxLeverage: 20
            };
        });

        status.exchangeInfo = temp;

        status.isReady = true;

        addBotLog('✅ BOT READY');

        initWS();

        fallbackAPI();

        updateCandidates();

        priceMonitor();

        autoTradeLoop();

    } catch (e) {

        addBotLog(

            `INIT ERROR ${e.message}`,

            'error'
        );
    }
}

// ============================================================================
// START SERVER
// ============================================================================

APP.listen(PORT, () => {

    console.log(
        `BOT RUNNING http://localhost:${PORT}`
    );

    addBotLog(
        `🌐 SERVER ${PORT}`
    );
});

// ============================================================================
// RUN
// ============================================================================

init();
