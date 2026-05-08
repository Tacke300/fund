import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    timeout: 20000,
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
        adjustForTimeDifference: true,
        recvWindow: 60000
    }
});

let botSettings = {
    isRunning: false,
    maxPositions: 3,
    invValue: "1%",
    minVol: 6.5,
    posTP: 0.5,
    posSL: 50.0,
    dcaStep: 10.0,
    maxDCA: 4
};

let status = {
    botLogs: [],
    exchangeInfo: null,
    candidatesList: [],
    isReady: false,
    blackList: {},
    botClosedCount: 0,
    botPnLClosed: 0
};

let botActivePositions = new Map();
let timestampOffset = 0;
let openingSymbols = new Set();

function addBotLog(msg, type = 'info') {

    const time = new Date().toLocaleTimeString(
        'vi-VN',
        { hour12: false }
    );

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

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function binancePrivate(
    endpoint,
    method = 'GET',
    data = {}
) {

    const timestamp = Date.now() + timestampOffset;

    const query = new URLSearchParams({
        ...data,
        timestamp,
        recvWindow: 60000
    }).toString();

    const signature = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(query)
        .digest('hex');

    try {

        const response = await binanceApi({
            method,
            url: `${endpoint}?${query}&signature=${signature}`
        });

        return response.data;

    } catch (error) {

        throw new Error(
            error.response?.data?.msg || error.message
        );
    }
}

async function clearAllOldTPSL(symbol, side = 'SHORT') {

    try {

        const orders = await binancePrivate(
            '/fapi/v1/openOrders',
            'GET',
            { symbol }
        );

        const tpslOrders = orders.filter(o =>
            (
                o.type === 'TAKE_PROFIT_MARKET' ||
                o.type === 'STOP_MARKET'
            ) &&
            o.positionSide === side
        );

        if (tpslOrders.length === 0) {
            return true;
        }

        for (const o of tpslOrders) {

            try {

                await binancePrivate(
                    '/fapi/v1/order',
                    'DELETE',
                    {
                        symbol,
                        orderId: o.orderId
                    }
                );

                addBotLog(
                    `🧹 [${symbol}] Xóa ${o.type} #${o.orderId}`
                );

            } catch (err) {

                addBotLog(
                    `⚠️ [${symbol}] Fail xóa ${o.orderId}`,
                    'error'
                );
            }
        }

        await sleep(1500);

        const verify = await binancePrivate(
            '/fapi/v1/openOrders',
            'GET',
            { symbol }
        );

        const stillExist = verify.some(o =>
            (
                o.type === 'TAKE_PROFIT_MARKET' ||
                o.type === 'STOP_MARKET'
            ) &&
            o.positionSide === side
        );

        if (stillExist) {

            addBotLog(
                `❌ [${symbol}] TPSL vẫn tồn tại`,
                'error'
            );

            return false;
        }

        addBotLog(
            `✅ [${symbol}] TPSL đã dọn sạch`
        );

        return true;

    } catch (e) {

        addBotLog(
            `❌ [${symbol}] clearTPSL lỗi: ${e.message}`,
            'error'
        );

        return false;
    }
}

async function syncTPSL(symbol, side, entry, info) {

    const isShort = (side === 'SHORT');

    const tpPrice = (
        entry *
        (
            isShort
                ? (1 - botSettings.posTP / 100)
                : (1 + botSettings.posTP / 100)
        )
    ).toFixed(info.pricePrecision);

    const slPrice = (
        entry *
        (
            isShort
                ? (1 + botSettings.posSL / 100)
                : (1 - botSettings.posSL / 100)
        )
    ).toFixed(info.pricePrecision);

    const sideClose = isShort ? 'buy' : 'sell';

    try {

        const cleaned = await clearAllOldTPSL(
            symbol,
            side
        );

        if (!cleaned) {

            return {
                success: false,
                ids: []
            };
        }

        await sleep(1000);

        const tpRes = await exchange.createOrder(
            symbol,
            'TAKE_PROFIT_MARKET',
            sideClose,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice: tpPrice,
                closePosition: true,
                workingType: 'MARK_PRICE'
            }
        );

        await sleep(800);

        const slRes = await exchange.createOrder(
            symbol,
            'STOP_MARKET',
            sideClose,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice: slPrice,
                closePosition: true,
                workingType: 'MARK_PRICE'
            }
        );

        addBotLog(
            `✨ [${symbol}] TP/SL OK`
        );

        return {
            tp: parseFloat(tpPrice),
            sl: parseFloat(slPrice),
            ids: [tpRes.id, slRes.id],
            success: true
        };

    } catch (e) {

        addBotLog(
            `❌ [${symbol}] Lỗi TP/SL: ${e.message}`,
            'error'
        );

        return {
            success: false,
            ids: []
        };
    }
}

async function openPosition(symbol, isDCA = false) {

    const posKey = `${symbol}_SHORT`;

    if (
        !isDCA &&
        (
            status.blackList[symbol] || 0
        ) > Date.now()
    ) return;

    if (isDCA) {

        const cp = botActivePositions.get(posKey);

        if (!cp || cp.isProcessing) {
            return;
        }

        cp.isProcessing = true;

    } else {

        if (
            botActivePositions.has(posKey) ||
            openingSymbols.has(symbol)
        ) return;

        openingSymbols.add(symbol);
    }

    try {

        const info = status.exchangeInfo[symbol];

        const ticker = await binanceApi.get(
            `/fapi/v1/ticker/price?symbol=${symbol}`
        );

        const currentPrice = parseFloat(
            ticker.data.price
        );

        let marginToUse = 0;
        let currentDCA = 0;
        let firstMargin = 0;

        if (isDCA) {

            const cp = botActivePositions.get(posKey);

            firstMargin = cp.firstMargin;

            marginToUse = firstMargin * 1.5;

            currentDCA = cp.dcaCount + 1;

        } else {

            const acc = await binancePrivate(
                '/fapi/v2/account'
            );

            marginToUse =
                botSettings.invValue.toString().includes('%')
                    ? (
                        parseFloat(acc.availableBalance)
                        *
                        parseFloat(
                            botSettings.invValue.replace('%', '')
                        )
                        / 100
                    )
                    : parseFloat(botSettings.invValue);

            firstMargin = marginToUse;
        }

        let qtyNum = Math.ceil(
            (
                (
                    marginToUse *
                    info.maxLeverage
                ) / currentPrice
            ) / info.stepSize
        ) * info.stepSize;

        while (
            (qtyNum * currentPrice) < 5.5
        ) {
            qtyNum += info.stepSize;
        }

        await exchange.setLeverage(
            info.maxLeverage,
            symbol
        );

        const order = await exchange.createOrder(
            symbol,
            'market',
            'sell',
            qtyNum.toFixed(info.quantityPrecision),
            undefined,
            {
                positionSide: 'SHORT'
            }
        );

        if (order) {

            await sleep(4500);

            const posData = await binancePrivate(
                '/fapi/v2/positionRisk',
                'GET',
                { symbol }
            );

            const realPos = posData.find(p =>
                p.positionSide === 'SHORT' &&
                Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (realPos) {

                const finalEntry = parseFloat(
                    realPos.entryPrice
                );

                const finalQty = Math.abs(
                    parseFloat(realPos.positionAmt)
                );

                const finalMargin =
                    (
                        finalQty *
                        finalEntry
                    ) / info.maxLeverage;

                const sync = await syncTPSL(
                    symbol,
                    'SHORT',
                    finalEntry,
                    info
                );

                const logResult = sync.success
                    ? `✨ TP/SL OK`
                    : `❌ TP/SL FAIL`;

                addBotLog(
                    `🚀 [${symbol}] ${isDCA ? 'DCA' : 'OPEN'} Khớp: Entry ${finalEntry} | Margin: ${finalMargin.toFixed(2)}$ | ${logResult}`
                );

                botActivePositions.set(posKey, {
                    symbol,
                    side: 'SHORT',
                    entryPrice: finalEntry,
                    qty: finalQty,
                    tp: sync.success ? sync.tp : 0,
                    sl: sync.success ? sync.sl : 0,
                    firstMargin,
                    dcaCount: currentDCA,
                    leverage: info.maxLeverage,
                    margin: finalMargin,
                    isProcessing: false,
                    markPrice: currentPrice,
                    pnl: 0,
                    priceDev: 0
                });
            }
        }

    } catch (e) {

        addBotLog(
            `🚨 [${symbol}] ${e.message}`,
            'error'
        );

        if (
            isDCA &&
            botActivePositions.has(posKey)
        ) {
            botActivePositions.get(posKey).isProcessing = false;
        }

    } finally {

        openingSymbols.delete(symbol);
    }
}

async function trackClosedPnL(symbol, lastBotPos) {

    try {

        await sleep(5000);

        const trades = await binancePrivate(
            '/fapi/v1/userTrades',
            'GET',
            {
                symbol,
                limit: 20
            }
        );

        const now = Date.now();

        const recentTrades = trades.filter(t =>
            (now - t.time) < 60000
        );

        const rawPnL = recentTrades.reduce(
            (sum, t) =>
                sum + parseFloat(t.realizedPnl),
            0
        );

        const totalVolume =
            lastBotPos.qty *
            lastBotPos.entryPrice;

        const estimatedFee =
            totalVolume * 0.001;

        const finalPnL =
            rawPnL - estimatedFee;

        status.botClosedCount++;
        status.botPnLClosed += finalPnL;

        addBotLog(
            `✅ CHỐT ${symbol} | PnL: ${finalPnL.toFixed(2)}$`,
            'success'
        );

    } catch (e) {}
}

async function priceMonitorLoop() {

    if (!status.isReady) {
        setTimeout(priceMonitorLoop, 1000);
        return;
    }

    try {

        const posRisk = await binancePrivate(
            '/fapi/v2/positionRisk'
        );

        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {

            const realPos = posRisk.find(p =>
                p.symbol === botPos.symbol &&
                p.positionSide === botPos.side
            );

            if (
                !realPos ||
                Math.abs(parseFloat(realPos.positionAmt)) === 0
            ) {

                status.blackList[botPos.symbol] =
                    now + (15 * 60 * 1000);

                trackClosedPnL(
                    botPos.symbol,
                    botPos
                );

                botActivePositions.delete(key);

            } else {

                botPos.markPrice = parseFloat(
                    realPos.markPrice
                );

                botPos.pnl = parseFloat(
                    realPos.unRealizedProfit
                );

                botPos.priceDev =
                    (
                        (
                            botPos.markPrice -
                            botPos.entryPrice
                        ) /
                        botPos.entryPrice
                    ) * 100;
            }
        }

    } catch (e) {}

    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {

    if (
        !status.isReady ||
        !botSettings.isRunning
    ) return;

    try {

        const now = Date.now();

        Object.keys(status.blackList)
            .forEach(s => {

                if (
                    status.blackList[s] < now
                ) {
                    delete status.blackList[s];
                }
            });

        for (let [key, botPos] of botActivePositions) {

            if (botPos.isProcessing) {
                continue;
            }

            if (
                botPos.priceDev >= botSettings.dcaStep &&
                botPos.dcaCount < botSettings.maxDCA
            ) {

                await openPosition(
                    botPos.symbol,
                    true
                );
            }
        }

        if (
            botActivePositions.size < botSettings.maxPositions &&
            openingSymbols.size === 0
        ) {

            const keo = status.candidatesList.find(c => {

                const info =
                    status.exchangeInfo[c.symbol];

                const hasVol =
                    Math.abs(parseFloat(c.c1)) >= parseFloat(botSettings.minVol) ||
                    Math.abs(parseFloat(c.c5)) >= parseFloat(botSettings.minVol);

                return (
                    info &&
                    info.maxLeverage >= 20 &&
                    !status.blackList[c.symbol] &&
                    !botActivePositions.has(`${c.symbol}_SHORT`) &&
                    hasVol
                );
            });

            if (keo) {

                await openPosition(
                    keo.symbol,
                    false
                );
            }
        }

    } catch (e) {}
}

async function init() {

    try {

        const timeRes = await axios.get(
            'https://fapi.binance.com/fapi/v1/time'
        );

        timestampOffset =
            timeRes.data.serverTime - Date.now();

        await exchange.loadMarkets();

        const infoRes = await binanceApi.get(
            '/fapi/v1/exchangeInfo'
        );

        const brkRes = await binancePrivate(
            '/fapi/v1/leverageBracket'
        );

        const tempInfo = {};

        infoRes.data.symbols.forEach(s => {

            const lot = s.filters.find(
                f => f.filterType === 'LOT_SIZE'
            );

            const brk =
                (
                    Array.isArray(brkRes)
                        ? brkRes
                        : brkRes.brackets || []
                ).find(
                    b => b.symbol === s.symbol
                );

            tempInfo[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(lot.stepSize),
                maxLeverage: brk
                    ? brk.brackets[0].initialLeverage
                    : 20
            };
        });

        status.exchangeInfo = tempInfo;

        status.isReady = true;

        addBotLog(
            "👿 LUFFY V18.0 FIX TPSL",
            "success"
        );

        priceMonitorLoop();

    } catch (e) {

        setTimeout(init, 5000);
    }
}

init();

setInterval(mainLoop, 3000);

setInterval(() => {

    http.get(
        'http://127.0.0.1:9000/api/data',
        res => {

            let d = '';

            res.on('data', c => d += c);

            res.on('end', () => {

                try {

                    status.candidatesList =
                        JSON.parse(d).live || [];

                } catch (e) {}
            });
        }
    ).on('error', () => {});

}, 2000);

const APP = express();

APP.use(express.json());

APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {

    try {

        const acc = await binancePrivate(
            '/fapi/v2/account'
        );

        const bl = {};

        Object.entries(status.blackList)
            .forEach(([s, t]) => {

                if (t > Date.now()) {

                    bl[s] = Math.ceil(
                        (t - Date.now()) / 1000
                    );
                }
            });

        res.json({
            botSettings,
            activePositions: Array.from(
                botActivePositions.values()
            ),
            status: {
                ...status,
                blackList: bl
            },
            wallet: {
                totalWalletBalance: parseFloat(
                    acc.totalWalletBalance
                ).toFixed(2),

                availableBalance: parseFloat(
                    acc.availableBalance
                ).toFixed(2),

                totalUnrealizedProfit: parseFloat(
                    acc.totalUnrealizedProfit
                ).toFixed(2)
            }
        });

    } catch (e) {

        res.json({ status });
    }
});

APP.post('/api/settings', (req, res) => {

    botSettings = {
        ...botSettings,
        ...req.body
    };

    res.json({
        success: true
    });
});

APP.get('/', (req, res) => {

    res.sendFile(
        path.join(__dirname, 'index.html')
    );
});

APP.listen(9001);
