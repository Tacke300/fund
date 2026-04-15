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
    headers: { 'X-MBX-APIKEY': API_KEY }
});

const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    options: { defaultType: 'future', dualSidePosition: true }
});

// KHÔI PHỤC ĐẦY ĐỦ THÔNG SỐ CŨ
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1, 
    invType: 'percent', 
    minVol: 6.5, 
    posTP: 0.5, 
    posSL: 5.0 
};

let status = { 
    botLogs: [], 
    exchangeInfo: null, 
    candidatesList: [], 
    isReady: false,
    blackList: {},
    activePositions: [] 
};

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    // Chỉ log nếu thông điệp khác với cái gần nhất để chống spam
    if (status.botLogs.length > 0 && status.botLogs[0].msg === msg) return;
    
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) { throw new Error(error.response?.data?.msg || error.message); }
}

async function openPosition(symbol, side) {
    if (status.blackList[symbol] && Date.now() < status.blackList[symbol]) return;
    if (!status.exchangeInfo || !status.exchangeInfo[symbol]) return;
    
    const info = status.exchangeInfo[symbol];
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';

    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const avail = parseFloat(acc.availableBalance);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        
        let margin = botSettings.invType === 'percent' ? (avail * botSettings.invValue) / 100 : botSettings.invValue;
        let notional = margin * info.maxLeverage;
        if (notional < 5.2) notional = 5.2;

        let qty = ((notional / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', side.toLowerCase(), qty, undefined, { positionSide: posSide });

        if (order) {
            const entry = order.price || price;
            // TÍNH TOÁN TP/SL THEO SETTINGS
            const tp = (posSide === 'LONG' ? entry * (1 + botSettings.posTP/100) : entry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (posSide === 'LONG' ? entry * (1 - botSettings.posSL/100) : entry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);
            
            const sideClose = posSide === 'LONG' ? 'sell' : 'buy';
            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: posSide, stopPrice: tp, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: posSide, stopPrice: sl, closePosition: true })
            ]).catch(() => {});

            addBotLog(`🚀 Mở lệnh: ${symbol} ${posSide} | TP: ${botSettings.posTP}% SL: ${botSettings.posSL}%`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error"); }
}

async function syncAndTrade() {
    if (!status.isReady) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        
        const livePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);
        
        // CHỈ ĐƯA VÀO BLACKLIST KHI THỰC SỰ BIẾN MẤT KHỎI SÀN
        status.activePositions.forEach(oldPos => {
            const exists = livePositions.find(p => p.symbol === oldPos.symbol && p.positionSide === oldPos.side);
            if (!exists) {
                if (!status.blackList[oldPos.symbol] || now > status.blackList[oldPos.symbol]) {
                    status.blackList[oldPos.symbol] = now + (15 * 60 * 1000);
                    addBotLog(`🔒 ${oldPos.symbol} đã đóng. Khóa 15p.`, "info");
                }
            }
        });

        status.activePositions = livePositions.map(p => ({
            symbol: p.symbol,
            side: p.positionSide,
            entryPrice: parseFloat(p.entryPrice).toFixed(status.exchangeInfo[p.symbol]?.pricePrecision || 4),
            markPrice: parseFloat(p.markPrice).toFixed(status.exchangeInfo[p.symbol]?.pricePrecision || 4),
            pnl: parseFloat(p.unRealizedProfit).toFixed(2),
            margin: (Math.abs(p.positionAmt) * p.entryPrice / p.leverage).toFixed(2)
        }));

        if (botSettings.isRunning && status.activePositions.length < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const isBlack = status.blackList[c.symbol] && now < status.blackList[c.symbol];
                const isOpen = status.activePositions.find(p => p.symbol === c.symbol);
                return !isOpen && !isBlack && Math.abs(c.c1) >= botSettings.minVol;
            });
            if (keo) await openPosition(keo.symbol, keo.c1 >= 0 ? 'BUY' : 'SELL');
        }
    } catch (e) { console.error("Sync Error"); }
}

async function init() {
    try {
        await exchange.setPositionMode(true).catch(() => {});
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
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), 
                maxLeverage: (brk && brk.brackets) ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY v18.1 - STABLE", "success");
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(syncAndTrade, 4000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: status.activePositions, status }));
APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    res.json({ success: true }); 
});
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
