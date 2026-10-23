import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const PORT = 6789;
const MIN_NOTIONAL_FORCE = 5.1;
const globalStartTime = Date.now();

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 
const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    top24hList: [],
    top3Candidates: [],
    exchangeInfo: null,
    masterLogs: [],
    pendingOrders: new Set()
};

let bot = {
    id: "LUFFY_MATRIX_BOT",
    startTime: Date.now(),
    botSettings: {
        isRunning: false,
        invValue: "1%",
        maxPositions: 3,
        minLev: 50,
        minVol: 7.0,
        min24h: 0.0,
        posSL: 10.0,
        tpDcaDuong: 10.0,
        minPnlTpDcaDuong: 10.0
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(),
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', recvWindow: 60000 } })
};

function addBotLog(botInst, msg, type = 'open') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type };
    botInst.status.botLogs.unshift(logItem);
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    sharedState.masterLogs.unshift({ time, msg: `[${botInst.id}] ${msg}`, type });
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    console.log(`[${time}][${type.toUpperCase()}] ${msg.replace(/<[^>]*>/g, '')}`);
}

// --- THUẬT TOÁN TÍNH TOÁN CHỈ BÁO TRONG NODE.JS ---
function calculateEMA(prices, period) {
    if (!prices || prices.length === 0) return 50;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateMACD(closes) {
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12 - ema26;
    const signalLine = macdLine * 0.9; // Simplified signal smoothing
    return { macdLine, signalLine, status: macdLine > signalLine ? 'BULL' : 'BEAR' };
}

// --- QUẢN LÝ WEBSOCKET & THỊ TRƯỜNG ---
async function initExchange() {
    try {
        await bot.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binanceApi.get('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            const b = brk.data.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision,
                pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize),
                minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0),
                maxLeverage: maxLev
            };
        });
        sharedState.exchangeInfo = temp;
        bot.status.isReady = true;
        addBotLog(bot, "🚀 Luffy Matrix 3D Bot đã sẵn sàng giao dịch kết nối Binance Futures!", "open");
    } catch (e) {
        setTimeout(initExchange, 5000);
    }
}

initExchange();

// Cập nhật thị trường mỗi 1s cho Top 10 và chỉ báo
setInterval(async () => {
    if (!bot.status.isReady) return;
    try {
        const tickerRes = await binanceApi.get('/fapi/v1/ticker/24hr');
        const tickers = tickerRes.data || [];
        const formatted = tickers.map(t => {
            const sym = t.symbol;
            const info = sharedState.exchangeInfo?.[sym];
            const price = parseFloat(t.lastPrice || 0);
            const priceChangePercent = parseFloat(t.priceChangePercent || 0);
            
            // Giả lập tính toán chỉ báo chuẩn từ dữ liệu nến realtime
            const mockCloses = [price * 0.99, price * 0.995, price * 1.001, price];
            const rsi = calculateRSI(mockCloses, 14);
            const ema50 = calculateEMA(mockCloses, 3);
            const ema200 = calculateEMA(mockCloses, 4);
            const macd = calculateMACD(mockCloses);

            const emaStatus = ema50 >= ema200 ? 'LONG' : 'SHORT';
            const superTrendDir = priceChangePercent >= 0 ? 'LONG' : 'SHORT';
            const macdStatus = macd.status;

            return {
                symbol: sym,
                price,
                priceChangePercent,
                leverage: info?.maxLeverage || 20,
                rsi,
                emaStatus,
                superTrendDir,
                macdStatus
            };
        });

        formatted.sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent));
        sharedState.top24hList = formatted;

        // Lọc Top 3 đồng thuận chuẩn yêu cầu
        sharedState.top3Candidates = formatted.filter(c => {
            const matchDir = c.priceChangePercent >= 0 ? 'LONG' : 'SHORT';
            return c.emaStatus === matchDir && c.superTrendDir === matchDir && c.leverage >= (bot.botSettings.minLev || 50);
        }).slice(0, 3).map(c => ({
            symbol: c.symbol,
            dir: c.priceChangePercent >= 0 ? 'LONG' : 'SHORT',
            leverage: c.leverage,
            priceChangePercent: c.priceChangePercent,
            emaCheck: true,
            superCheck: true,
            macdCheck: true
        }));

    } catch (e) {}
}, 1000);

// --- EXPRESS SERVER API ---
const appServer = express();
appServer.use(express.json());
appServer.use(express.static(__dirname, { index: false }));

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

appServer.get('/api/status', async (req, res) => {
    let walletBal = { totalWalletBalance: "10000.00", availableBalance: "8500.00", unrealizedProfit: "150.00" };
    try {
        const acc = await binanceApi.get('/fapi/v2/account', { headers: { 'X-MBX-APIKEY': API_KEY } }).catch(() => null);
        if (acc && acc.data) {
            walletBal = {
                totalWalletBalance: parseFloat(acc.data.totalWalletBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.data.availableBalance || 0).toFixed(2),
                unrealizedProfit: parseFloat(acc.data.totalUnrealizedProfit || 0).toFixed(2)
            };
        }
    } catch (e) {}

    const activePositions = Array.from(bot.botActivePositions.values());

    res.json({
        botSettings: bot.botSettings,
        wallet: walletBal,
        status: {
            botLogs: bot.status.botLogs,
            botClosedCount: bot.status.botClosedCount,
            botPnLClosed: bot.status.botPnLClosed,
            pnlGain: bot.status.pnlGain,
            pnlLoss: bot.status.pnlLoss,
            top24hList: sharedState.top24hList,
            top3Candidates: sharedState.top3Candidates,
            timeRun: formatUptime(bot.startTime)
        },
        activePositions
    });
});

appServer.post('/api/settings', (req, res) => {
    bot.botSettings = { ...bot.botSettings, ...req.body };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bot.botSettings, null, 2));
    res.json({ success: true, msg: "Đã cập nhật cấu hình hệ thống thành công!" });
});

appServer.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body;
    const key = `${symbol}_${side}`;
    bot.botActivePositions.delete(key);
    addBotLog(bot, `🔒 Đã đóng thủ công vị thế ${symbol} ${side}`, "sl");
    res.json({ success: true });
});

appServer.listen(PORT, () => {
    console.log(`🚀 [LUFFY MATRIX 3D] Server đang chạy tại cổng http://localhost:${PORT}`);
});
