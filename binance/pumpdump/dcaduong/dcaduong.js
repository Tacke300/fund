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

let scannerRunning = false;

let miniTickerCache = {};

let klineCache = {};

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
// WS
// =========================================================================

async function startVolatilityWebsocket() {

    const ws = new WebSocket(

        'wss://fstream.binance.com/ws/!miniTicker@arr'
    );

    ws.on('open', () => {

        addBotLog(
            '📡 Volatility WS Connected'
        );
    });

    ws.on('message', async raw => {

        try {

            const data = JSON.parse(raw);

            for (const t of data) {

                if (
                    !t.s.endsWith('USDT') ||
                    t.s.includes('_')
                ) continue;

                miniTickerCache[t.s] = {

                    symbol: t.s,

                    close: parseFloat(t.c),

                    open: parseFloat(t.o),

                    high: parseFloat(t.h),

                    low: parseFloat(t.l),

                    volume: parseFloat(t.v),

                    time: Date.now()
                };
            }

        } catch (e) {}
    });

    ws.on('close', () => {

        addBotLog(
            '⚠️ WS Closed',
            'error'
        );

        setTimeout(
            startVolatilityWebsocket,
            3000
        );
    });

    ws.on('error', e => {

        addBotLog(
            `WS Error: ${e.message}`,
            'error'
        );
    });
}

// =========================================================================
// PRELOAD KLINES
// =========================================================================

async function preloadKlines() {

    try {

        const tickers =
            Object.keys(miniTickerCache)
                .slice(0, 80);

        for (const symbol of tickers) {

            try {

                const kl =
                    await binanceApi.get(

                        `/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=16`
                    );

                if (
                    !kl.data ||
                    kl.data.length < 16
                ) continue;

                klineCache[symbol] =
                    kl.data.map(x => ({

                        open:
                            parseFloat(x[1]),

                        high:
                            parseFloat(x[2]),

                        low:
                            parseFloat(x[3]),

                        close:
                            parseFloat(x[4]),

                        volume:
                            parseFloat(x[5]),

                        closeTime: x[6]
                    }));

            } catch (e) {}
        }

        addBotLog(

            `📊 Preloaded ${Object.keys(klineCache).length} pairs`
        );

    } catch (e) {

        addBotLog(
            `Preload error: ${e.message}`,
            'error'
        );
    }
}

// =========================================================================
// UPDATE LIVE KLINE
// =========================================================================

function updateLiveKline() {

    const now = Date.now();

    const currentMinute =
        Math.floor(now / 60000);

    for (const symbol in miniTickerCache) {

        const ticker =
            miniTickerCache[symbol];

        if (!ticker) continue;

        if (!klineCache[symbol]) {

            klineCache[symbol] = [];
        }

        const arr =
            klineCache[symbol];

        let last =
            arr[arr.length - 1];

        if (!last) {

            arr.push({

                open: ticker.close,

                high: ticker.close,

                low: ticker.close,

                close: ticker.close,

                volume: ticker.volume,

                minute: currentMinute
            });

            continue;
        }

        if (last.minute !== currentMinute) {

            arr.push({

                open: ticker.close,

                high: ticker.close,

                low: ticker.close,

                close: ticker.close,

                volume: ticker.volume,

                minute: currentMinute
            });

            if (arr.length > 20) {

                arr.shift();
            }

        } else {

            last.close = ticker.close;

            if (ticker.close > last.high) {

                last.high = ticker.close;
            }

            if (ticker.close < last.low) {

                last.low = ticker.close;
            }

            last.volume = ticker.volume;
        }
    }
}

// =========================================================================
// SCANNER
// =========================================================================

async function updateCandidates() {

    if (scannerRunning) return;

    scannerRunning = true;

    try {

        updateLiveKline();

        const result = [];

        for (const symbol in klineCache) {

            const k = klineCache[symbol];

            if (!k || k.length < 16) continue;

            try {

                const last =
                    k[k.length - 1].close;

                const p1 =
                    k[k.length - 2].close;

                const p5 =
                    k[k.length - 6].close;

                const p15 =
                    k[k.length - 16].close;

                const c1 =
                    ((last - p1) / p1) * 100;

                const c5 =
                    ((last - p5) / p5) * 100;

                const c15 =
                    ((last - p15) / p15) * 100;

                const score =

                    Math.abs(c1) +

                    Math.abs(c5) +

                    Math.abs(c15);

                result.push({

                    symbol,

                    c1: c1.toFixed(2),

                    c5: c5.toFixed(2),

                    c15: c15.toFixed(2),

                    score
                });

            } catch (e) {}
        }

        result.sort(
            (a, b) => b.score - a.score
        );

        status.candidatesList =
            result.slice(0, 30);

    } catch (e) {

        addBotLog(
            `Scanner error: ${e.message}`,
            'error'
        );

    } finally {

        scannerRunning = false;
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
        '🚀 Starting scanner system...'
    );

    await startVolatilityWebsocket();

    setTimeout(async () => {

        await preloadKlines();

        updateCandidates();

    }, 5000);
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

            // ======================================
            // TAKE PROFIT
            // ======================================

            if (
                b.dcaCount > 0 &&
                !isProcessingDCA.has(b.symbol)
            ) {

                const target =

                    b.side === 'LONG'

                        ? avgEntry * 1.01

                        : avgEntry * 0.99;

                if (

                    (b.side === 'LONG' && markP >= target)

                    ||

                    (b.side === 'SHORT' && markP <= target)
                ) {

                    isProcessingDCA.add(
                        b.symbol
                    );

                    addBotLog(

                        `✅ Close ${b.symbol} Profit`
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

            // ======================================
            // DCA
            // ======================================

            if (

                b.dcaCount < botSettings.maxDca

                &&

                !isProcessingDCA.has(b.symbol)
            ) {

                const trigger =

                    (b.dcaCount + 1)

                    *

                    botSettings.dcaPercent;

                if (

                    (b.side === 'LONG' &&
                        b.priceDev >= trigger)

                    ||

                    (b.side === 'SHORT' &&
                        b.priceDev <= -trigger)
                ) {

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
// OPEN POSITION
// =========================================================================

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

        } else {

            const acc =
                await binancePrivate(
                    '/fapi/v2/account'
                );

            margin =

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
        }

        qty = Math.ceil(

            (
                (margin * info.maxLeverage)

                / currentPrice
            )

            / info.stepSize

        ) * info.stepSize;

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

        await new Promise(
            r => setTimeout(r, 1000)
        );

        const positions =
            await binancePrivate(

                '/fapi/v2/positionRisk',

                'GET',

                { symbol }
            );

        const p = positions.find(x =>

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

                firstMargin: margin
            }
        );

        addBotLog(

            `📡 ${symbol} ${finalSide} OPEN`
        );

    } catch (e) {

        addBotLog(
            `Open error: ${e.message}`,
            'error'
        );

    } finally {

        setTimeout(() => {

            isProcessingDCA.delete(symbol);

        }, 2000);
    }
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

    } finally {

        setTimeout(() => {

            isProcessingDCA.delete(symbol);

        }, 2000);
    }
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
