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

// =========================================================================
// CONFIG
// =========================================================================

const PORT = 1114;

const __filename =
    fileURLToPath(import.meta.url);

const __dirname =
    path.dirname(__filename);

const CONFIG_FILE =
    path.join(__dirname, 'bot_config.json');

// =========================================================================
// EXPRESS
// =========================================================================

const APP = express();

APP.use(express.json());

APP.use(express.static(__dirname));

// =========================================================================
// BINANCE
// =========================================================================

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

// =========================================================================
// SETTINGS
// =========================================================================

let botSettings = {

    isRunning: false,

    capital: '1%',

    volVolatility: 6.5,

    maxPos: 3,

    maxDca: 2,

    dcaPercent: 10,

    tp: 1.2,

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

// =========================================================================
// GLOBAL
// =========================================================================

let timestampOffset = 0;

let currentBotIP = null;

let botActivePositions = new Map();

let isProcessingDCA = new Set();

let coinData = {};

let status = {

    botLogs: [],

    candidatesList: [],

    blackList: {},

    permanentBlacklist: {},

    botClosedCount: 0,

    botPnLClosed: 0,

    exchangeInfo: {},

    isReady: false
};

// =========================================================================
// LOG
// =========================================================================

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

    if (status.botLogs.length > 150) {

        status.botLogs.pop();
    }

    console.log(`[${time}] ${msg}`);
}

// =========================================================================
// PRIVATE REQUEST
// =========================================================================

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

// =========================================================================
// VOLATILITY ENGINE
// =========================================================================

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

// =========================================================================
// WEBSOCKET
// =========================================================================

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

                .slice(0, 80)

                .map(t =>
                    t.symbol.toLowerCase()
                );

        const streamString =

            symbols.map(s =>
                `${s}@ticker`
            ).join('/');

        const ws = new WebSocket(

            `wss://fstream.binance.com/stream?streams=${streamString}`
        );

        ws.on('open', () => {

            addBotLog(
                '📡 Volatility WS Connected'
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
                '⚠️ WS Reconnecting...',
                'error'
            );

            setTimeout(
                initWS,
                1000
            );
        });

        ws.on('error', e => {

            addBotLog(
                `WS Error: ${e.message}`,
                'error'
            );
        });

    } catch (e) {

        addBotLog(
            `WS Init Error: ${e.message}`,
            'error'
        );
    }
}

// =========================================================================
// FALLBACK API
// =========================================================================

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

// =========================================================================
// UPDATE CANDIDATES
// =========================================================================

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

                .slice(0, 30);

        status.candidatesList = topData;

    } catch (e) {

        addBotLog(
            `Scanner error: ${e.message}`,
            'error'
        );
    }

    setTimeout(
        updateCandidates,
        1000
    );
}

// =========================================================================
// START SCANNER
// =========================================================================

async function startScannerSystem() {

    addBotLog(
        '🚀 Starting volatility engine...'
    );

    initWS();

    fallbackAPI();

    updateCandidates();
}

// =========================================================================
// CLOSE POSITION
// =========================================================================

async function closePositionMarket(

    symbol,

    side,

    qty
) {

    try {

        const closeSide =

            side === 'LONG'

                ? 'SELL'

                : 'BUY';

        await binancePrivate(

            '/fapi/v1/order',

            'POST',

            {

                symbol,

                side: closeSide,

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

        status.botClosedCount++;

        addBotLog(
            `❌ ${symbol} CLOSED`
        );

    } catch (e) {

        addBotLog(
            `Close error: ${e.message}`,
            'error'
        );
    }
}

// =========================================================================
// PRICE MONITOR
// =========================================================================

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

        for (const [key, b] of botActivePositions) {

            const realP =
                posRisk.find(p =>

                    `${p.symbol}_${p.positionSide}` === key &&

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

            b.avgEntryPrice = avgEntry;

            b.priceDev = (

                (markP - b.firstEntry)

                / b.firstEntry

            ) * 100;

            // TP

            if (

                b.dcaCount > 0 &&

                !isProcessingDCA.has(b.symbol)
            ) {

                const target =

                    b.side === 'LONG'

                        ? avgEntry * 1.01

                        : avgEntry * 0.99;

                if (

                    (b.side === 'LONG' &&
                        markP >= target)

                    ||

                    (b.side === 'SHORT' &&
                        markP <= target)
                ) {

                    isProcessingDCA.add(
                        b.symbol
                    );

                    await closePositionMarket(

                        b.symbol,

                        b.side,

                        Math.abs(
                            parseFloat(
                                realP.positionAmt
                            )
                        )
                    );

                    continue;
                }
            }
        }

    } catch (e) {

        addBotLog(
            `Monitor error: ${e.message}`,
            'error'
        );
    }

    setTimeout(
        priceMonitor,
        1000
    );
}

// =========================================================================
// STATUS API
// =========================================================================

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

        const activePositions = [];

        for (const [k, pos] of botActivePositions) {

            activePositions.push({

                symbol: pos.symbol,

                side: pos.side,

                dcaCount: pos.dcaCount
            });
        }

        res.json({

            wallet,

            activePositions,

            status: {

                botLogs:
                    status.botLogs,

                candidatesList:
                    status.candidatesList,

                botClosedCount:
                    status.botClosedCount,

                totalClosedPnL:
                    status.botPnLClosed
            },

            settings:
                botSettings,

            isRunning:
                botSettings.isRunning,

            ip:
                currentBotIP
        });

    } catch (e) {

        res.status(500).json({

            error: e.message
        });
    }
});

// =========================================================================
// SETTINGS
// =========================================================================

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
        '⚙️ Settings Saved'
    );

    res.json({
        success: true
    });
});

// =========================================================================
// START
// =========================================================================

APP.post('/api/start', (req, res) => {

    botSettings.isRunning = true;

    addBotLog('🚀 BOT STARTED');

    res.json({
        success: true
    });
});

// =========================================================================
// STOP
// =========================================================================

APP.post('/api/stop', (req, res) => {

    botSettings.isRunning = false;

    addBotLog('⛔ BOT STOPPED');

    res.json({
        success: true
    });
});

// =========================================================================
// PANIC CLOSE
// =========================================================================

APP.post('/api/panic-close', async (req, res) => {

    try {

        const positions =
            await binancePrivate(
                '/fapi/v2/positionRisk'
            );

        for (const p of positions) {

            const amt =
                parseFloat(p.positionAmt);

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
                `⚠️ Panic Close ${p.symbol}`
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

// =========================================================================
// INIT
// =========================================================================

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

        try {

            const ip =
                await axios.get(

                    'https://api.ipify.org?format=json'
                );

            currentBotIP =
                ip.data.ip;

        } catch (e) {}

        status.isReady = true;

        addBotLog('✅ BOT READY');

        startScannerSystem();

        priceMonitor();

    } catch (e) {

        addBotLog(
            `Init error: ${e.message}`,
            'error'
        );
    }
}

// =========================================================================
// START SERVER
// =========================================================================

APP.listen(PORT, () => {

    console.log(
        `BOT RUNNING http://localhost:${PORT}`
    );

    addBotLog(
        `🌐 Server Running ${PORT}`
    );
});

// =========================================================================
// RUN
// =========================================================================

init();
