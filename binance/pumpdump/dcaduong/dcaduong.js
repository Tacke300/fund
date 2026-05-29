import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// CONFIG
// =========================================================================

const PORT = 1114;

const MARGIN_PROTECT_LIMIT = 60;
const MARGIN_RECOVER_LIMIT = 70;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

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
    capital: "1%",
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
            ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
        };

    } catch (e) {

        console.log("Config load error:", e.message);
    }
}

// =========================================================================
// GLOBAL STATE
// =========================================================================

let timestampOffset = 0;
let currentBotIP = null;
let isMarginProtected = false;

let botActivePositions = new Map();
let isProcessingDCA = new Set();

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

    const time = new Date().toLocaleTimeString('vi-VN', {
        hour12: false
    });

    status.botLogs.unshift({
        time,
        msg,
        type
    });

    if (status.botLogs.length > 100) {
        status.botLogs.pop();
    }

    console.log(`[${time}] ${msg}`);
}

// =========================================================================
// SIGNED REQUEST
// =========================================================================

async function binancePrivate(endpoint, method = 'GET', data = {}) {

    try {

        const timestamp = Date.now() + timestampOffset;

        const queryStr = new URLSearchParams({
            ...data,
            timestamp,
            recvWindow: 60000
        }).toString();

        const signature = crypto
            .createHmac('sha256', SECRET_KEY)
            .update(queryStr)
            .digest('hex');

        const response = await binanceApi({
            method,
            url: `${endpoint}?${queryStr}&signature=${signature}`
        });

        return response.data;

    } catch (e) {

        if (e.response?.data?.code === -1021) {

            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');

            timestampOffset = t.data.serverTime - Date.now();

            return binancePrivate(endpoint, method, data);
        }

        throw e;
    }
}

// =========================================================================
// UPDATE CANDIDATES
// =========================================================================

async function updateCandidates() {

    try {

        const tickers = await binanceApi.get('/fapi/v1/ticker/24hr');

        const filtered = tickers.data
            .filter(x => x.symbol.endsWith('USDT'))
            .map(x => {

                const change = parseFloat(x.priceChangePercent);

                return {
                    symbol: x.symbol,
                    c1: (change / 12).toFixed(2),
                    c5: (change / 4).toFixed(2),
                    c15: change.toFixed(2)
                };
            })
            .sort((a, b) => Math.abs(b.c15) - Math.abs(a.c15));

        status.candidatesList = filtered.slice(0, 30);

    } catch (e) {

        addBotLog(`Candidate error: ${e.message}`, 'error');
    }

    setTimeout(updateCandidates, 3000);
}

// =========================================================================
// PRICE MONITOR
// =========================================================================

async function priceMonitor() {

    if (!status.isReady) {
        return setTimeout(priceMonitor, 1000);
    }

    try {

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');

        for (const [key, b] of botActivePositions) {

            const realP = posRisk.find(p =>
                `${p.symbol}_${p.positionSide}` === key &&
                Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (!realP) {

                botActivePositions.delete(key);
                continue;
            }

            const markP = parseFloat(realP.markPrice);
            const avgEntry = parseFloat(realP.entryPrice);

            b.avgEntryPrice = avgEntry;

            b.priceDev = (
                (markP - b.firstEntry) / b.firstEntry
            ) * 100;

            // CLOSE PROFIT

            if (b.dcaCount > 0 && !isProcessingDCA.has(b.symbol)) {

                const target =
                    b.side === 'LONG'
                        ? avgEntry * 1.01
                        : avgEntry * 0.99;

                if (
                    (b.side === 'LONG' && markP >= target) ||
                    (b.side === 'SHORT' && markP <= target)
                ) {

                    isProcessingDCA.add(b.symbol);

                    addBotLog(
                        `✅ Close ${b.symbol} profit`
                    );

                    await closePositionMarket(
                        b.symbol,
                        b.side,
                        Math.abs(parseFloat(realP.positionAmt))
                    );

                    continue;
                }
            }

            // DCA

            if (
                b.dcaCount < botSettings.maxDca &&
                !isProcessingDCA.has(b.symbol)
            ) {

                const trigger =
                    (b.dcaCount + 1) * botSettings.dcaPercent;

                if (
                    (b.side === 'LONG' && b.priceDev >= trigger) ||
                    (b.side === 'SHORT' && b.priceDev <= -trigger)
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

        addBotLog(`Monitor error: ${e.message}`, 'error');
    }

    setTimeout(priceMonitor, 1000);
}

// =========================================================================
// CLOSE POSITION
// =========================================================================

async function closePositionMarket(symbol, side, qty) {

    try {

        const closeSide =
            side === 'LONG'
                ? 'SELL'
                : 'BUY';

        await binancePrivate('/fapi/v1/order', 'POST', {
            symbol,
            side: closeSide,
            positionSide: side,
            type: 'MARKET',
            quantity: qty
        });

        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', {
            symbol
        });

        botActivePositions.delete(`${symbol}_${side}`);

        status.blackList[symbol] =
            Date.now() + (15 * 60 * 1000);

        status.botClosedCount++;

        addBotLog(`❌ Closed ${symbol}`);

    } catch (e) {

        addBotLog(`Close error: ${e.message}`, 'error');

    } finally {

        setTimeout(() => {
            isProcessingDCA.delete(symbol);
        }, 2000);
    }
}

// =========================================================================
// OPEN POSITION
// =========================================================================

async function openPosition(symbol, dcaData = null, triggerSide = 'LONG') {

    if (isProcessingDCA.has(symbol)) return;

    isProcessingDCA.add(symbol);

    try {

        const info = status.exchangeInfo[symbol];

        if (!info) return;

        const ticker = (
            await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)
        ).data;

        const currentPrice = parseFloat(ticker.price);

        let qty;
        let margin;

        if (dcaData) {

            margin =
                dcaData.firstMargin *
                Math.pow(2, dcaData.dcaCount + 1);

        } else {

            const acc = await binancePrivate('/fapi/v2/account');

            margin = botSettings.capital.includes('%')
                ? (
                    parseFloat(acc.availableBalance) *
                    parseFloat(botSettings.capital) / 100
                )
                : parseFloat(botSettings.capital);
        }

        qty = Math.ceil(
            ((margin * info.maxLeverage) / currentPrice) /
            info.stepSize
        ) * info.stepSize;

        await exchange.setLeverage(
            info.maxLeverage,
            symbol
        );

        const finalSide =
            (dcaData ? dcaData.side : triggerSide);

        await exchange.createOrder(
            symbol,
            'MARKET',
            finalSide === 'SHORT'
                ? 'SELL'
                : 'BUY',
            qty.toFixed(info.quantityPrecision),
            undefined,
            {
                positionSide: finalSide
            }
        );

        await new Promise(r => setTimeout(r, 1000));

        const positions = await binancePrivate(
            '/fapi/v2/positionRisk',
            'GET',
            { symbol }
        );

        const p = positions.find(x =>
            x.positionSide === finalSide &&
            Math.abs(parseFloat(x.positionAmt)) > 0
        );

        if (!p) return;

        const entry = parseFloat(p.entryPrice);

        botActivePositions.set(
            `${symbol}_${finalSide}`,
            {
                symbol,
                side: finalSide,
                firstEntry: dcaData
                    ? dcaData.firstEntry
                    : entry,
                dcaCount: dcaData
                    ? dcaData.dcaCount + 1
                    : 0,
                firstMargin: margin
            }
        );

        addBotLog(
            `📡 ${symbol} ${dcaData ? 'DCA' : 'NEW'} ${finalSide}`
        );

    } catch (e) {

        addBotLog(`Open error: ${e.message}`, 'error');

    } finally {

        setTimeout(() => {
            isProcessingDCA.delete(symbol);
        }, 2000);
    }
}

// =========================================================================
// API STATUS
// =========================================================================

APP.get('/api/status', async (req, res) => {

    try {

        let wallet = {
            totalWalletBalance: '0.00',
            availableBalance: '0.00',
            totalUnrealizedProfit: '0.00'
        };

        try {

            const acc = await binancePrivate('/fapi/v2/account');

            wallet = {
                totalWalletBalance:
                    parseFloat(acc.totalWalletBalance).toFixed(2),

                availableBalance:
                    parseFloat(acc.availableBalance).toFixed(2),

                totalUnrealizedProfit:
                    parseFloat(acc.totalUnrealizedProfit).toFixed(2)
            };

        } catch (e) {}

        const activePositions = [];

        for (const [key, pos] of botActivePositions) {

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
                botLogs: status.botLogs,
                candidatesList: status.candidatesList,
                botClosedCount: status.botClosedCount,
                totalClosedPnL: status.botPnLClosed
            },
            settings: botSettings,
            isRunning: botSettings.isRunning,
            ip: currentBotIP
        });

    } catch (e) {

        res.status(500).json({
            error: e.message
        });
    }
});

// =========================================================================
// SAVE SETTINGS
// =========================================================================

APP.post('/api/settings', (req, res) => {

    botSettings = {
        ...botSettings,
        ...req.body
    };

    fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(botSettings, null, 2)
    );

    addBotLog('⚙️ Settings saved');

    res.json({
        success: true
    });
});

// =========================================================================
// START BOT
// =========================================================================

APP.post('/api/start', (req, res) => {

    botSettings.isRunning = true;

    addBotLog('🚀 BOT STARTED');

    res.json({
        success: true
    });
});

// =========================================================================
// STOP BOT
// =========================================================================

APP.post('/api/stop', (req, res) => {

    botSettings.isRunning = false;

    addBotLog('🛑 BOT STOPPED');

    res.json({
        success: true
    });
});

// =========================================================================
// PANIC CLOSE
// =========================================================================

APP.post('/api/panic-close', async (req, res) => {

    try {

        const positions = await binancePrivate('/fapi/v2/positionRisk');

        for (const p of positions) {

            const amt = parseFloat(p.positionAmt);

            if (amt === 0) continue;

            const qty = Math.abs(amt);

            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol: p.symbol,
                side: amt > 0 ? 'SELL' : 'BUY',
                positionSide: p.positionSide,
                type: 'MARKET',
                quantity: qty
            });

            addBotLog(`⚠️ Panic close ${p.symbol}`);
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

        addBotLog('Loading exchange info...');

        const info = await binanceApi.get('/fapi/v1/exchangeInfo');

        const temp = {};

        info.data.symbols.forEach(s => {

            const lotFilter = s.filters.find(
                f => f.filterType === 'LOT_SIZE'
            );

            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                stepSize: parseFloat(lotFilter.stepSize),
                maxLeverage: 20
            };
        });

        status.exchangeInfo = temp;

        try {

            const ip = await axios.get(
                'https://api.ipify.org?format=json'
            );

            currentBotIP = ip.data.ip;

        } catch (e) {}

        status.isReady = true;

        addBotLog('✅ BOT READY');

        updateCandidates();

        priceMonitor();

    } catch (e) {

        addBotLog(`Init error: ${e.message}`, 'error');
    }
}

// =========================================================================
// START SERVER
// =========================================================================

APP.listen(PORT, () => {

    console.log(`BOT RUNNING: http://localhost:${PORT}`);

    addBotLog(`🌐 Server running port ${PORT}`);
});

// =========================================================================
// RUN
// =========================================================================

init();
