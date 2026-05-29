import express from 'express';
import axios from 'axios';
import WebSocket from 'ws';
import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const PORT = 1114;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, 'config_data.json');
const POS_FILE = path.join(__dirname, 'positions.json');

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

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ==========================
// STATE
// ==========================

let botSettings = {
    isRunning: false,
    capital: 1%,
    volVolatility: 7,
    maxPos: 300,
    dcaPercent: 10,
    tp: 30,
    sl: 10
};

if (fs.existsSync(CONFIG_FILE)) {
    botSettings = {
        ...botSettings,
        ...JSON.parse(fs.readFileSync(CONFIG_FILE))
    };
}

let positions = new Map();

if (fs.existsSync(POS_FILE)) {
    JSON.parse(fs.readFileSync(POS_FILE)).forEach(p => {
        positions.set(`${p.symbol}_${p.side}`, p);
    });
}

let coinData = {};
let status = { botLogs: [] };

let blockedCoins = new Map(); // 15p block
let permanentBlocked = new Set(); // lev <20 or lỗi
let loggedMessages = new Set();
let marginProtect = false;

// ==========================
// LOG
// ==========================

function addLog(msg) {
    if (loggedMessages.has(msg)) return;

    loggedMessages.add(msg);

    setTimeout(() => {
        loggedMessages.delete(msg);
    }, 60000);

    const time = new Date().toLocaleTimeString('vi-VN', {
        hour12: false
    });

    status.botLogs.unshift({ time, msg });

    if (status.botLogs.length > 300) {
        status.botLogs.pop();
    }

    console.log(`[${time}] ${msg}`);
}

// ==========================
// SAVE
// ==========================

function saveState() {
    fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(botSettings, null, 2)
    );

    fs.writeFileSync(
        POS_FILE,
        JSON.stringify(Array.from(positions.values()), null, 2)
    );
}

// ==========================
// UTILS
// ==========================

async function getPublicIP() {
    try {
        const res = await axios.get('https://api.ipify.org?format=json');
        return res.data.ip;
    } catch {
        return '0.0.0.0';
    }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;

    const now = Date.now();

    let start =
        pArr.find(i => i.t >= (now - min * 60000)) ||
        pArr[0];

    return parseFloat(
        (
            (
                (pArr[pArr.length - 1].p - start.p) /
                start.p
            ) * 100
        ).toFixed(2)
    );
}

// ==========================
// BALANCE PROTECT
// ==========================

async function monitorBalanceProtection() {
    try {
        const balance = await exchange.fetchBalance();

        const total =
            balance.USDT?.total || 0;

        const free =
            balance.USDT?.free || 0;

        if (!total || total <= 0) return;

        const ratio = (free / total) * 100;

        if (!marginProtect && ratio <= 60) {
            marginProtect = true;
            addLog(`🛑 MARGIN PROTECT ON (${ratio.toFixed(2)}%)`);
        }

        if (marginProtect && ratio >= 70) {
            marginProtect = false;
            addLog(`✅ MARGIN PROTECT OFF (${ratio.toFixed(2)}%)`);
        }

    } catch (e) {}
}

// ==========================
// WS
// ==========================

async function initWS() {
    try {

        const res = await axios.get(
            'https://fapi.binance.com/fapi/v1/ticker/price'
        );

        const symbols = res.data
            .filter(t => t.symbol.endsWith('USDT'))
            .map(t => t.symbol.toLowerCase());

        const ws = new WebSocket(
            `wss://fstream.binance.com/stream?streams=${
                symbols
                    .slice(0, 50)
                    .map(s => `${s}@ticker`)
                    .join('/')
            }`
        );

        ws.on('message', raw => {

            const msg = JSON.parse(raw);

            if (!msg.data) return;

            const s = msg.data.s;
            const p = parseFloat(msg.data.c);

            if (!coinData[s]) {
                coinData[s] = {
                    prices: []
                };
            }

            coinData[s].prices.push({
                p,
                t: Date.now()
            });

            if (coinData[s].prices.length > 1200) {
                coinData[s].prices.shift();
            }

            coinData[s].live = {
                c1: calculateChange(coinData[s].prices, 1),
                c5: calculateChange(coinData[s].prices, 5),
                c15: calculateChange(coinData[s].prices, 15),
                currentPrice: p
            };
        });

        ws.on('close', () => {
            setTimeout(initWS, 5000);
        });

    } catch (e) {
        setTimeout(initWS, 5000);
    }
}

// ==========================
// LEVERAGE
// ==========================

async function getRealLeverage(symbol) {
    try {

        const markets = await exchange.loadMarkets();

        const lev = markets[symbol]?.leverage || 20;

        if (lev < 20) {
            permanentBlocked.add(symbol);
            addLog(`⛔ BLOCK VĨNH VIỄN ${symbol} | LEV ${lev}x`);
            return null;
        }

        return lev;

    } catch (e) {
        permanentBlocked.add(symbol);
        return null;
    }
}

// ==========================
// OPEN POSITION
// ==========================

async function openPosition(
    symbol,
    side,
    currentPrice,
    isDca = false,
    isVip = false
) {

    const key = `${symbol}_${side}`;

    // anti spam
    if (!isDca && positions.has(key)) {
        return;
    }

    // permanent block
    if (permanentBlocked.has(symbol)) {
        return;
    }

    // 15m block
    const blockedUntil = blockedCoins.get(symbol);

    if (
        blockedUntil &&
        Date.now() < blockedUntil
    ) {
        return;
    }

    const maxLev = await getRealLeverage(symbol);

    if (!maxLev) return;

    try {

        let margin = parseFloat(botSettings.capital);

        if (isDca) {

            const p = positions.get(key);

            // anti dca spam
            if (
                p.lastDcaTime &&
                Date.now() - p.lastDcaTime < 10000
            ) {
                return;
            }

            margin = isVip
                ? p.marginInitial * Math.pow(2, p.dca + 1)
                : p.marginInitial;
        }

        const qty =
            (margin * maxLev) / currentPrice;

        await exchange.setLeverage(maxLev, symbol);

        await exchange.createOrder(
            symbol,
            'market',
            side === 'LONG' ? 'buy' : 'sell',
            qty,
            undefined,
            {
                positionSide: side
            }
        );

        if (!isDca) {

            positions.set(key, {
                symbol,
                side,
                qty,
                avg: currentPrice,
                entryInitial: currentPrice,
                marginInitial: margin,
                dca: 0,
                isVip,
                startTime: Date.now(),
                lastDcaTime: 0
            });

            addLog(`🚀 OPEN ${symbol} ${side}`);

        } else {

            const p = positions.get(key);

            p.dca++;

            p.lastDcaTime = Date.now();

            p.avg =
                (
                    (
                        p.avg * p.qty
                    ) +
                    (
                        currentPrice * qty
                    )
                ) /
                (
                    p.qty + qty
                );

            p.qty += qty;

            addLog(
                `💵 DCA ${symbol} ${side} | AVG ${p.avg.toFixed(4)}`
            );
        }

        saveState();

    } catch (e) {

        permanentBlocked.add(symbol);

        addLog(`⛔ BLOCK ERROR ${symbol}`);
    }
}

// ==========================
// AUTO TRADE
// ==========================

async function autoTradeLoop() {

    try {

        if (
            !botSettings.isRunning ||
            marginProtect
        ) {
            return setTimeout(autoTradeLoop, 2000);
        }

        if (
            positions.size >= botSettings.maxPos
        ) {
            return setTimeout(autoTradeLoop, 2000);
        }

        const market = Object.entries(coinData)
            .filter(([, v]) => v.live);

        for (const [symbol, v] of market) {

            if (permanentBlocked.has(symbol)) {
                continue;
            }

            const blockedUntil =
                blockedCoins.get(symbol);

            if (
                blockedUntil &&
                Date.now() < blockedUntil
            ) {
                continue;
            }

            const c1 = Math.abs(v.live.c1);
            const c5 = Math.abs(v.live.c5);
            const c15 = Math.abs(v.live.c15);

            const isVip =
                c1 > 15 ||
                c5 > 15;

            let valid = false;

            // VIP
            if (isVip) {

                valid =
                    c1 > botSettings.volVolatility &&
                    c5 > botSettings.volVolatility;

            } else {

                valid =
                    c1 > botSettings.volVolatility &&
                    c5 > botSettings.volVolatility &&
                    c15 > botSettings.volVolatility;
            }

            if (!valid) continue;

            const side =
                (
                    v.live.c1 +
                    v.live.c5 +
                    v.live.c15
                ) >= 0
                    ? 'LONG'
                    : 'SHORT';

            await openPosition(
                symbol,
                side,
                v.live.currentPrice,
                false,
                isVip
            );

            break;
        }

    } catch (e) {}

    setTimeout(autoTradeLoop, 2000);
}

// ==========================
// MONITOR
// ==========================

async function monitorLoop() {

    try {

        for (const [key, p] of positions) {

            const cp =
                coinData[p.symbol]?.live?.currentPrice;

            if (!cp) continue;

            const isRecover = (
                p.side === 'LONG'
            )
                ? cp >= p.avg * 1.01
                : cp <= p.avg * 0.99;

            const isSl = (
                p.side === 'LONG'
            )
                ? cp <= p.entryInitial * (1 - botSettings.sl / 100)
                : cp >= p.entryInitial * (1 + botSettings.sl / 100);

            const isTimeout =
                Date.now() - p.startTime > 14400000;

            // CLOSE
            if (
                isRecover ||
                isSl ||
                isTimeout
            ) {

                try {

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

                } catch (e) {}

                blockedCoins.set(
                    p.symbol,
                    Date.now() + (15 * 60 * 1000)
                );

                positions.delete(key);

                saveState();

                addLog(`✅ CLOSE ${p.symbol}`);

                continue;
            }

            // DCA
            if (p.dca < 3) {

                const trigger = (
                    p.side === 'LONG'
                )
                    ? cp <= p.entryInitial * (1 - (0.10 * (p.dca + 1)))
                    : cp >= p.entryInitial * (1 + (0.10 * (p.dca + 1)));

                if (trigger) {

                    await openPosition(
                        p.symbol,
                        p.side,
                        cp,
                        true,
                        p.isVip
                    );
                }
            }
        }

    } catch (e) {}

    setTimeout(monitorLoop, 1000);
}

// ==========================
// SYNC BINANCE POSITIONS
// ==========================

async function syncPositionsLoop() {

    try {

        const realPositions =
            await exchange.fetchPositions();

        const realMap = new Map();

        for (const p of realPositions) {

            const contracts =
                parseFloat(p.contracts || 0);

            if (contracts <= 0) continue;

            const side =
                p.side === 'long'
                    ? 'LONG'
                    : 'SHORT';

            const key =
                `${p.symbol}_${side}`;

            realMap.set(key, true);

            if (!positions.has(key)) {

                positions.set(key, {
                    symbol: p.symbol,
                    side,
                    qty: contracts,
                    avg: parseFloat(p.entryPrice),
                    entryInitial: parseFloat(p.entryPrice),
                    marginInitial: botSettings.capital,
                    dca: 0,
                    isVip: false,
                    startTime: Date.now(),
                    lastDcaTime: 0
                });

                addLog(`♻️ SYNC ADD ${p.symbol}`);
            }
        }

        for (const [key, p] of positions) {

            if (!realMap.has(key)) {

                positions.delete(key);

                addLog(`🗑️ SYNC REMOVE ${p.symbol}`);
            }
        }

        saveState();

    } catch (e) {}

    setTimeout(syncPositionsLoop, 5000);
}

// ==========================
// BALANCE LOOP
// ==========================

async function balanceLoop() {

    await monitorBalanceProtection();

    setTimeout(balanceLoop, 10000);
}

// ==========================
// API
// ==========================

app.post('/api/config', (req, res) => {

    botSettings = {
        ...botSettings,
        ...req.body
    };

    saveState();

    res.json({ ok: true });
});

app.post('/api/start', (req, res) => {

    botSettings.isRunning = true;

    saveState();

    res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {

    botSettings.isRunning = false;

    saveState();

    res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {

    res.json({
        botStatus: botSettings.isRunning,
        marginProtect,
        botIp: await getPublicIP(),
        activePositions: Array.from(positions.values()),
        status
    });
});

// ==========================
// START
// ==========================

app.listen(PORT, () => {

    initWS();

    autoTradeLoop();

    monitorLoop();

    syncPositionsLoop();

    balanceLoop();

    console.log(`✅ BOT RUNNING PORT ${PORT}`);
});
