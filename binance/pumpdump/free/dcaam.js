import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MARGIN_PROTECT_LIMIT = 60;
const MARGIN_RECOVER_LIMIT = 70;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    timeout: 15000,
    headers: { 'X-MBX-APIKEY': API_KEY }
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

let botSettings = {
    isRunning: false,
    capital: "1%",
    volVolatility: 6.5,
    maxPos: 3,
    maxDca: 2,
    tp: 1.2,
    sl: 10.0,
    longTp: 1.5,
    longSl: 8.0
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        botSettings = { ...botSettings, ...savedConfig };
    } catch (e) {
        console.error("Lỗi đọc config:", e.message);
    }
}

let status = {
    botLogs: [],
    candidatesList: [],
    blackList: {},
    permanentBlacklist: {},
    botClosedCount: 0,
    botPnLClosed: 0,
    exchangeInfo: null,
    isReady: false
};

let botActivePositions = new Map();
let isProcessingDCA = new Set();

let timestampOffset = 0;
let isMarginProtected = false;
let currentBotIP = null;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });

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

        const finalUrl =
            `${endpoint}?${queryStr}&signature=${signature}`;

        const response = await binanceApi({
            method,
            url: finalUrl
        });

        return response.data;

    } catch (e) {

        if (e.response?.data?.code === -1021) {

            const t = await axios.get(
                'https://fapi.binance.com/fapi/v1/time'
            );

            timestampOffset =
                t.data.serverTime - Date.now();

            return binancePrivate(endpoint, method, data);
        }

        throw e;
    }
}

/* =========================
   FORCE CROSS
========================= */

async function forceCross(symbol) {

    try {

        await binancePrivate(
            '/fapi/v1/marginType',
            'POST',
            {
                symbol,
                marginType: 'CROSSED'
            }
        );

    } catch (e) {}
}

/* =========================
   BLACKLIST CLEAN
========================= */

setInterval(() => {

    const now = Date.now();

    for (const symbol in status.blackList) {

        if (now > status.blackList[symbol]) {

            delete status.blackList[symbol];

            addBotLog(
                `🔄 Unban Blacklist: ${symbol}`,
                "success"
            );
        }
    }

}, 1000);

/* =========================
   PRICE MONITOR
========================= */

async function priceMonitor() {

    if (!status.isReady) {
        return setTimeout(priceMonitor, 1000);
    }

    try {

        const posRisk = await binancePrivate(
            '/fapi/v2/positionRisk'
        );

        for (let [key, b] of botActivePositions) {

            const realP = posRisk.find(p =>
                `${p.symbol}_${p.positionSide}` === key &&
                Math.abs(parseFloat(p.positionAmt)) > 0
            );

            /* =========================
               POSITION STILL OPEN
            ========================== */

            if (realP) {

                const currentQty =
                    Math.abs(parseFloat(realP.positionAmt));

                const markP =
                    parseFloat(realP.markPrice);

                b.pnl =
                    parseFloat(realP.unRealizedProfit);

                b.priceDev =
                    ((markP - b.entryPrice) / b.entryPrice) * 100;

                b.currentPrice = markP;

                b.lastMarkPrice = markP;

                b.lastLiqPrice =
                    parseFloat(realP.liquidationPrice);

                if (b.currentQty !== currentQty) {
                    b.currentQty = currentQty;
                }

                b.missCount = 0;

            } else {

                if (isProcessingDCA.has(b.symbol)) {
                    continue;
                }

                b.missCount = (b.missCount || 0) + 1;

                if (b.missCount < 4) {
                    continue;
                }

                await new Promise(r => setTimeout(r, 1000));

                let reasonOfClose = "MANUAL";
                let netPnl = b.pnl;
                let avgClosePrice = b.lastMarkPrice;

                try {

                    const openOrders =
                        await binancePrivate(
                            '/fapi/v1/openOrders',
                            'GET',
                            { symbol: b.symbol }
                        );

                    for (const o of openOrders.filter(
                        o => o.positionSide === b.side
                    )) {

                        await binancePrivate(
                            '/fapi/v1/order',
                            'DELETE',
                            {
                                symbol: b.symbol,
                                orderId: o.orderId
                            }
                        ).catch(() => {});
                    }

                } catch (e) {}

                /* =========================
                   FORCE CLOSE CHECK
                ========================== */

                const forceOrders =
                    await binancePrivate(
                        '/fapi/v1/forceOrders',
                        'GET',
                        {
                            symbol: b.symbol,
                            startTime: Date.now() - 120000,
                            limit: 5
                        }
                    ).catch(() => []);

                const isLiquidated =
                    forceOrders &&
                    forceOrders.some(f =>
                        f.symbol === b.symbol &&
                        f.positionSide === b.side
                    );

                if (isLiquidated) {

                    reasonOfClose = "LIQUIDATION";

                    avgClosePrice =
                        parseFloat(
                            forceOrders[0].price ||
                            b.lastMarkPrice
                        );

                } else {

                    const allOrders =
                        await binancePrivate(
                            '/fapi/v1/allOrders',
                            'GET',
                            {
                                symbol: b.symbol,
                                limit: 10
                            }
                        ).catch(() => []);

                    const closedOrders =
                        allOrders
                        .filter(o =>
                            o.positionSide === b.side &&
                            o.status === 'FILLED' &&
                            (
                                o.type === 'STOP_MARKET' ||
                                o.type === 'TAKE_PROFIT_MARKET'
                            )
                        )
                        .sort((a, b) =>
                            b.updateTime - a.updateTime
                        );

                    const closedById =
                        closedOrders.length > 0
                            ? closedOrders[0]
                            : null;

                    const isRecentOrder =
                        closedById &&
                        (Date.now() - closedById.updateTime)
                        < 5 * 60 * 1000;

                    if (isRecentOrder) {

                        reasonOfClose =
                            closedById.type === 'STOP_MARKET'
                                ? "SL_MARKET"
                                : "TP_MARKET";

                        avgClosePrice =
                            parseFloat(
                                closedById.avgPrice ||
                                closedById.stopPrice
                            );
                    }
                }

                /* =========================
                   REALIZED PNL
                ========================== */

                try {

                    const incomeHistory =
                        await binancePrivate(
                            '/fapi/v1/income',
                            'GET',
                            {
                                symbol: b.symbol,
                                incomeType: 'REALIZED_PNL',
                                startTime: Date.now() - 300000,
                                limit: 10
                            }
                        );

                    if (incomeHistory?.length > 0) {

                        const recentIncomes =
                            incomeHistory.filter(
                                i => i.time >
                                (Date.now() - 60000)
                            );

                        if (recentIncomes.length > 0) {

                            netPnl =
                                recentIncomes.reduce(
                                    (acc, curr) =>
                                        acc + parseFloat(curr.income),
                                    0
                                );

                        } else {

                            incomeHistory.sort(
                                (a, b) => b.time - a.time
                            );

                            netPnl =
                                parseFloat(
                                    incomeHistory[0].income
                                );
                        }
                    }

                } catch (e) {}

                /* =========================
                   CLEANUP
                ========================== */

                botActivePositions.delete(key);

                status.botClosedCount++;
                status.botPnLClosed += netPnl;

                const isFinalLong =
                    b.isFinalLong === true;

                if (netPnl > 0) {

                    status.blackList[b.symbol] =
                        Date.now() + (15 * 60 * 1000);

                } else {

                    if (
                        isFinalLong ||
                        reasonOfClose === 'LIQUIDATION'
                    ) {

                        status.blackList[b.symbol] =
                            Date.now() + (15 * 60 * 1000);

                    } else {

                        addBotLog(
                            `🔄 ${b.symbol} tiếp tục chuỗi DCA`,
                            "warn"
                        );
                    }
                }

                let logType =
                    netPnl > 0
                        ? "💰 [CHỐT LỜI]"
                        : "📉 [CẮT LỖ]";

                if (reasonOfClose === 'LIQUIDATION') {
                    logType = "💀 [CHÁY LỆNH]";
                }

                addBotLog(
                    `${logType} ${b.symbol} | ${b.side} | Qty:${b.currentQty} | DCA:${b.dcaCount}/${botSettings.maxDca} | Close:${avgClosePrice.toFixed(5)} | PnL:${netPnl.toFixed(4)}$ | Type:${reasonOfClose}`,
                    netPnl > 0 ? "success" : "error"
                );

                /* =========================
                   DCA LOGIC
                ========================== */

                if (
                    netPnl < 0 &&
                    b.side === 'SHORT' &&
                    reasonOfClose !== 'LIQUIDATION'
                ) {

                    if (!botSettings.isRunning) {

                        addBotLog(
                            `🛑 STOPPING: bỏ DCA ${b.symbol}`,
                            "warn"
                        );

                    } else {

                        const jump =
                            b.dcaCount + 1;

                        const currentAccumulatedLoss =
                            (b.totalLossAccumulated || 0)
                            + Math.abs(netPnl);

                        if (jump <= botSettings.maxDca) {

                            openPosition(
                                b.symbol,
                                {
                                    ...b,
                                    dcaCount: jump,
                                    margin:
                                        b.firstMargin *
                                        Math.pow(2, jump),
                                    totalLossAccumulated:
                                        currentAccumulatedLoss
                                }
                            );

                        } else {

                            openPosition(
                                b.symbol,
                                {
                                    ...b,
                                    isFinalLong: true,
                                    margin: b.firstMargin * 10
                                }
                            );
                        }
                    }
                }
            }
        }

    } catch (e) {

        console.error(
            "Monitor Err:",
            e.message
        );
    }

    setTimeout(priceMonitor, 1000);
}

/* =========================
   OPEN POSITION
========================= */

async function openPosition(symbol, dcaData = null) {

    if (status.permanentBlacklist[symbol]) {
        return;
    }

    if (isProcessingDCA.has(symbol)) {
        return;
    }

    isProcessingDCA.add(symbol);

    const isDCAorLong =
        dcaData !== null;

    const side =
        dcaData?.isFinalLong
            ? 'LONG'
            : 'SHORT';

    try {

        const info =
            status.exchangeInfo[symbol];

        await new Promise(r => setTimeout(r, 1000));

        const acc =
            await binancePrivate('/fapi/v2/account');

        if (!acc) {
            throw new Error(
                "Không lấy được account"
            );
        }

        const availableUsdt =
            parseFloat(acc.availableBalance || 0);

        /* =========================
           MARK PRICE
        ========================== */

        const premium =
            await binancePrivate(
                '/fapi/v1/premiumIndex',
                'GET',
                { symbol }
            );

        const currentPrice =
            parseFloat(premium.markPrice);

        let qty = 0;
        let margin = 0;

        if (!isDCAorLong) {

            const riskCheck =
                await binancePrivate(
                    '/fapi/v2/positionRisk',
                    'GET',
                    { symbol }
                );

            const hasPos =
                riskCheck.some(
                    x =>
                        Math.abs(
                            parseFloat(x.positionAmt)
                        ) > 0
                );

            if (hasPos) {

                addBotLog(
                    `⚠️ ${symbol} đã có vị thế`,
                    "warn"
                );

                isProcessingDCA.delete(symbol);

                return;
            }
        }

        if (isDCAorLong) {

            margin = dcaData.margin;

            if ((margin * info.maxLeverage) < 6.5) {
                margin = 6.5 / info.maxLeverage;
            }

            qty =
                Math.ceil(
                    (
                        (
                            margin *
                            info.maxLeverage
                        ) / currentPrice
                    ) / info.stepSize
                ) * info.stepSize;

        } else {

            margin =
                botSettings.capital.toString().includes('%')
                    ? (
                        availableUsdt *
                        parseFloat(botSettings.capital)
                    ) / 100
                    : parseFloat(botSettings.capital);

            const desiredQty =
                (
                    margin *
                    info.maxLeverage
                ) / currentPrice;

            const minQtyRequiredByFloor =
                5.05 / currentPrice;

            const finalQtyBeforeRound =
                Math.max(
                    desiredQty,
                    minQtyRequiredByFloor
                );

            qty =
                Math.ceil(
                    finalQtyBeforeRound /
                    info.stepSize
                ) * info.stepSize;

            if (qty < info.stepSize) {
                qty = info.stepSize;
            }
        }

        const actualMarginUsed =
            (qty * currentPrice) /
            info.maxLeverage;

        /* =========================
           FORCE CROSS
        ========================== */

        await forceCross(symbol);

        await exchange.setLeverage(
            info.maxLeverage,
            symbol
        );

        const order =
            await exchange.createOrder(
                symbol,
                'MARKET',
                side === 'SHORT'
                    ? 'SELL'
                    : 'BUY',
                qty.toFixed(
                    info.quantityPrecision
                ),
                undefined,
                {
                    positionSide: side
                }
            );

        if (order) {

            await new Promise(
                r => setTimeout(r, 1500)
            );

            const pRisk =
                await binancePrivate(
                    '/fapi/v2/positionRisk',
                    'GET',
                    { symbol }
                );

            const p =
                pRisk.find(
                    x =>
                        x.positionSide === side &&
                        Math.abs(
                            parseFloat(x.positionAmt)
                        ) > 0
                );

            if (p) {

                const entry =
                    parseFloat(p.entryPrice);

                const firstE =
                    dcaData
                        ? dcaData.firstEntry
                        : entry;

                const dcaCount =
                    dcaData
                        ? dcaData.dcaCount
                        : 0;

                const dcaHistory =
                    dcaData
                        ? [...dcaData.dcaHistory, entry]
                        : [entry];

                const sumPrices =
                    dcaHistory.reduce(
                        (sum, p) => sum + p,
                        0
                    );

                const simpleAvgEntry =
                    sumPrices / dcaHistory.length;

                let tp = 0;
                let sl = 0;

                let firstQty =
                    dcaData
                        ? dcaData.firstQty
                        : qty;

                let firstProfitUsdt =
                    dcaData
                        ? dcaData.firstProfitUsdt
                        : (
                            qty *
                            entry *
                            (botSettings.tp / 100)
                        );

                let accumulatedLoss =
                    dcaData
                        ? dcaData.totalLossAccumulated
                        : 0;

                if (side === 'LONG') {

                    tp =
                        entry *
                        (
                            1 +
                            (botSettings.longTp / 100)
                        );

                    sl =
                        entry *
                        (
                            1 -
                            (botSettings.longSl / 100)
                        );

                } else {

                    const multiplier =
                        dcaCount + 1;

                    const totalTargetGrossProfit =
                        accumulatedLoss +
                        (
                            multiplier *
                            firstProfitUsdt
                        );

                    tp =
                        simpleAvgEntry -
                        (
                            totalTargetGrossProfit /
                            qty
                        );

                    sl =
                        firstE +
                        (
                            firstE *
                            (
                                botSettings.sl *
                                (dcaCount + 1)
                            ) / 100
                        );
                }

                const sync =
                    await syncTPSL(
                        symbol,
                        side,
                        info,
                        tp,
                        sl
                    );

                botActivePositions.set(
                    `${symbol}_${side}`,
                    {
                        symbol,
                        side,
                        entryPrice: entry,
                        currentPrice,
                        tp: sync.tp,
                        sl: sync.sl,
                        dcaCount,
                        leverage: info.maxLeverage,
                        firstEntry: firstE,
                        firstMargin:
                            dcaData
                                ? dcaData.firstMargin
                                : actualMarginUsed,
                        currentMargin: actualMarginUsed,
                        currentQty: qty,
                        virtualTotalQty: qty,
                        virtualTotalCost: qty * entry,
                        dcaHistory,
                        isFinalLong:
                            dcaData?.isFinalLong || false,
                        pnl: 0,
                        priceDev: 0,
                        firstQty,
                        firstProfitUsdt,
                        totalLossAccumulated:
                            accumulatedLoss
                    }
                );

                const modeStr =
                    isDCAorLong
                        ? (
                            dcaData.isFinalLong
                                ? 'LONG_CỨU'
                                : `DCA_${dcaData.dcaCount}`
                        )
                        : 'OPEN';

                addBotLog(
                    `📡 [${modeStr}] ${symbol} | ${side} | Qty:${qty} | Cross | Lev:x${info.maxLeverage} | Margin:${actualMarginUsed.toFixed(2)}$ | Entry:${entry} | TP:${sync.tp.toFixed(info.pricePrecision)} | SL:${sync.sl.toFixed(info.pricePrecision)}`
                );
            }
        }

    } catch (e) {

        status.permanentBlacklist[symbol] = true;

        addBotLog(
            `⛔ BLOCK ${symbol}: ${e.message}`,
            "error"
        );

    } finally {

        setTimeout(() => {

            isProcessingDCA.delete(symbol);

        }, 2000);
    }
}

/* =========================
   SYNC TP/SL
========================= */

async function syncTPSL(
    symbol,
    side,
    info,
    tpPrice,
    slPrice
) {

    const sideClose =
        side === 'SHORT'
            ? 'BUY'
            : 'SELL';

    try {

        const orders =
            await binancePrivate(
                '/fapi/v1/openOrders',
                'GET',
                { symbol }
            );

        for (const o of orders.filter(
            o => o.positionSide === side
        )) {

            await binancePrivate(
                '/fapi/v1/order',
                'DELETE',
                {
                    symbol,
                    orderId: o.orderId
                }
            );
        }

        await new Promise(
            r => setTimeout(r, 600)
        );

        /* =========================
           TP MARK PRICE
        ========================== */

        await exchange.createOrder(
            symbol,
            'TAKE_PROFIT_MARKET',
            sideClose,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice:
                    tpPrice.toFixed(
                        info.pricePrecision
                    ),
                closePosition: true,
                workingType: 'MARK_PRICE',
                priceProtect: true
            }
        );

        /* =========================
           SL MARK PRICE
        ========================== */

        await exchange.createOrder(
            symbol,
            'STOP_MARKET',
            sideClose,
            undefined,
            undefined,
            {
                positionSide: side,
                stopPrice:
                    slPrice.toFixed(
                        info.pricePrecision
                    ),
                closePosition: true,
                workingType: 'MARK_PRICE',
                priceProtect: true
            }
        );

        return {
            tp: tpPrice,
            sl: slPrice
        };

    } catch (e) {

        return {
            tp: 0,
            sl: 0
        };
    }
}

/* =========================
   SERVER
========================= */

const APP = express();

APP.use(express.json());
APP.use(express.static(__dirname));

APP.listen(1113, () => {
    console.log(`Server is running on port 1113`);
});
