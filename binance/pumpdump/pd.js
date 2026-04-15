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

// Cấu hình Axios tối ưu giữ kết nối
const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    timeout: 20000,
    headers: { 'X-MBX-APIKEY': API_KEY }
});

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    options: { defaultType: 'future', dualSidePosition: true }
});

let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', 
    minVol: 6.5, posTP: 0.5, posSL: 5.0 
};

let status = { 
    currentBalance: 0, availableBalance: 0, 
    botLogs: [], exchangeInfo: null, candidatesList: [], history: [] 
};

let activeOrdersTracker = new Map();
let isReady = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        throw new Error(error.response?.data?.msg || error.message);
    }
}

async function openPosition(symbol, side) {
    if (!status.exchangeInfo || !status.exchangeInfo[symbol]) return;

    const info = status.exchangeInfo[symbol];
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';

    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const avail = parseFloat(acc.availableBalance);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        
        let margin = botSettings.invType === 'percent' ? (avail * botSettings.invValue) / 100 : botSettings.invValue;
        let qty = ((margin * info.maxLeverage / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createMarketOrder(symbol, side.toLowerCase(), qty, { positionSide: posSide });

        if (order) {
            const entry = order.price || price;
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);
            
            const sideClose = posSide === 'LONG' ? 'sell' : 'buy';
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: posSide, stopPrice: tp, closePosition: true }).catch(()=>{});
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: posSide, stopPrice: sl, closePosition: true }).catch(()=>{});

            activeOrdersTracker.set(symbol, { 
                symbol, side: posSide, entryPrice: entry.toFixed(info.pricePrecision), 
                margin: margin.toFixed(2), markPrice: entry.toFixed(info.pricePrecision),
                tpPrice: tp, slPrice: sl
            });
            addBotLog(`✅ Khớp ${symbol} ${posSide}`, "success");
        }
    } catch (e) {
        addBotLog(`❌ Lỗi vào lệnh ${symbol}: ${e.message}`, "error");
    }
}

async function mainLoop() {
    if (!botSettings.isRunning || !isReady) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [symbol, data] of activeOrdersTracker) {
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === data.side);
            if (!p || parseFloat(p.positionAmt) === 0) {
                activeOrdersTracker.delete(symbol);
                continue;
            }
            data.markPrice = parseFloat(p.markPrice).toFixed(status.exchangeInfo[symbol]?.pricePrecision || 4);
        }
        if (activeOrdersTracker.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => !activeOrdersTracker.has(c.symbol) && Math.abs(c.c1) >= botSettings.minVol);
            if (keo) await openPosition(keo.symbol, keo.c1 >= 0 ? 'BUY' : 'SELL');
        }
    } catch (e) {}
}

async function init() {
    try {
        addBotLog("🔄 Đang kết nối sàn...");
        const [infoRes, brkRes] = await Promise.all([
            binanceApi.get('/fapi/v1/exchangeInfo'),
            binancePrivate('/fapi/v1/leverageBracket')
        ]);

        let brackets = Array.isArray(brkRes) ? brkRes : (brkRes.brackets || []);
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brackets.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: (brk && brk.brackets && brk.brackets[0]) ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        isReady = true;
        addBotLog("👿 LUFFY v17.5 - ONLINE", "success");
    } catch (e) {
        addBotLog(`❌ Lỗi kết nối: ${e.message}`, "error");
        setTimeout(init, 5000);
    }
}

init();
setInterval(mainLoop, 4000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });

APP.listen(9001, () => console.log("🌐 Server running on port 9001"));
