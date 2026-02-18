import https from 'https';
import http from 'http';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_FILE = path.join(__dirname, 'trade_history.json');

// --- CẤU HÌNH HỆ THỐNG ---
let botSettings = {
    isRunning: false,
    maxPositions: 10,
    invValue: 1.5,
    invType: 'fixed', 
    minVol: 5.0,
    accountSLValue: 30,
    accountSLType: 'percent', 
    isProtectProfit: true,
    openInterval: 30000 
};

let status = {
    initialBalance: 0,
    highestBalance: 0,
    currentBalance: 0,
    lastOpenTimestamp: 0,
    exchangeInfo: null,
    blacklist: new Set()
};

// --- HÀM CORE: BINANCE API CHUẨN ---
async function callSignedAPI(endpoint, method = 'GET', params = {}) {
    const timestamp = Date.now();
    let queryString = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=5000`;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
    const url = `https://fapi.binance.com${endpoint}?${queryString}&signature=${signature}`;

    return new Promise((resolve, reject) => {
        const options = { method, headers: { 'X-MBX-APIKEY': API_KEY } };
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
                    else reject(json);
                } catch (e) { reject({ msg: "JSON Parse Error", raw: data }); }
            });
        });
        req.on('error', e => reject({ msg: e.message }));
        req.end();
    });
}

// --- LẤY THÔNG SỐ SÀN (PRECISION) ---
async function refreshExchangeInfo() {
    try {
        const res = await new Promise((resolve) => {
            https.get('https://fapi.binance.com/fapi/v1/exchangeInfo', r => {
                let d = ''; r.on('data', c => d += c);
                r.on('end', () => resolve(JSON.parse(d)));
            });
        });
        status.exchangeInfo = {};
        res.symbols.forEach(s => {
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            status.exchangeInfo[s.symbol] = {
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: parseFloat(priceFilter.tickSize),
                stepSize: parseFloat(lotFilter.stepSize)
            };
        });
        console.log("⚓ Exchange Info Updated.");
    } catch (e) { console.error("Lỗi ExchangeInfo:", e); }
}

// --- LOGIC VÀO LỆNH PUMP/DUMP ---
async function openPumpDumpOrder(coin) {
    try {
        const symbol = coin.symbol;
        const info = status.exchangeInfo[symbol];
        if (!info) return;

        const posSide = coin.changePercent > 0 ? 'LONG' : 'SHORT';
        const side = posSide === 'LONG' ? 'BUY' : 'SELL';

        const ticker = await new Promise(res => {
            https.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, r => {
                let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
            });
        });
        const price = parseFloat(ticker.price);

        // Đòn bẩy theo biến động
        let leverage = 20;
        if (Math.abs(coin.changePercent) > 10) leverage = 50;
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });

        // Tính số lượng
        let investUSD = botSettings.invType === 'fixed' ? botSettings.invValue : (status.currentBalance * botSettings.invValue / 100);
        let qty = (investUSD * leverage) / price;
        qty = Math.floor(qty / info.stepSize) * info.stepSize;
        const finalQty = qty.toFixed(info.quantityPrecision);

        // Vào lệnh Market
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty
        });

        // Đặt TP/SL
        let marginGain = 1.0; 
        if (leverage >= 50) marginGain = 3.0;
        const priceMove = (price * marginGain) / leverage;
        const tpPrice = (posSide === 'LONG' ? price + priceMove : price - priceMove);
        const slPrice = (posSide === 'LONG' ? price - (priceMove/2) : price + (priceMove/2));

        const batch = [
            { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: (Math.round(tpPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision), closePosition: 'true' },
            { symbol, side: side === 'BUY' ? 'SELL' : 'BUY', positionSide: posSide, type: 'STOP_MARKET', stopPrice: (Math.round(slPrice / info.tickSize) * info.tickSize).toFixed(info.pricePrecision), closePosition: 'true' }
        ];
        await callSignedAPI('/fapi/v1/batchOrders', 'POST', { batchOrders: JSON.stringify(batch) });

        status.lastOpenTimestamp = Date.now();
        saveLog(symbol, posSide, investUSD, marginGain*100);
    } catch (e) {
        console.error(`Lỗi vào lệnh ${coin.symbol}:`, e.msg || e);
        status.blacklist.add(coin.symbol);
    }
}

// --- VÒNG LẶP CHÍNH ---
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const acc = await callSignedAPI('/fapi/v2/account');
        status.currentBalance = parseFloat(acc.totalMarginBalance);

        if (status.initialBalance === 0) {
            status.initialBalance = status.currentBalance;
            status.highestBalance = status.currentBalance;
        }

        if (botSettings.isProtectProfit && status.currentBalance > status.highestBalance) {
            status.highestBalance = status.currentBalance;
        }

        let stopThreshold = botSettings.accountSLType === 'fixed' 
            ? status.highestBalance - botSettings.accountSLValue 
            : status.highestBalance * (1 - botSettings.accountSLValue / 100);

        if (status.currentBalance <= stopThreshold) return panicStop("Chạm ngưỡng SL Tài khoản!");

        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePos = positions.filter(p => parseFloat(p.positionAmt) !== 0);

        if (activePos.length >= botSettings.maxPositions) return;
        if (Date.now() - status.lastOpenTimestamp < botSettings.openInterval) return;

        // Quét VPS1
        http.get('http://34.142.248.96:9000/', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', async () => {
                try {
                    const vps = JSON.parse(data);
                    if (vps.status !== "running_data_available") return;
                    const candidates = vps.data
                        .filter(c => Math.abs(c.changePercent) >= botSettings.minVol)
                        .filter(c => !activePos.some(p => p.symbol === c.symbol))
                        .filter(c => !status.blacklist.has(c.symbol))
                        .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

                    if (candidates.length > 0) await openPumpDumpOrder(candidates[0]);
                } catch (e) {}
            });
        });
    } catch (e) {}
}

async function panicStop(reason) {
    botSettings.isRunning = false;
    console.error("STOP:", reason);
}

function saveLog(symbol, side, capital, pnl) {
    const log = { symbol, side, capital, pnl, time: new Date().toLocaleString() };
    let logs = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [];
    logs.push(log);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(logs.slice(-100), null, 2));
}

// --- API WEB SERVER ---
const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));

APP.post('/api/settings', (req, res) => { botSettings = {...botSettings, ...req.body}; res.sendStatus(200); });
APP.get('/api/status', async (req, res) => {
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk');
        const activePositions = positions.filter(p => parseFloat(p.positionAmt) !== 0).map(p => {
            const entry = parseFloat(p.entryPrice);
            const amt = Math.abs(parseFloat(p.positionAmt));
            const pnl = parseFloat(p.unrealizedProfit);
            const margin = (entry * amt) / parseFloat(p.leverage);
            return {
                symbol: p.symbol,
                side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
                margin: margin.toFixed(2),
                pnlPercent: ((pnl / margin) * 100).toFixed(2)
            };
        });
        res.json({ botSettings, status, activePositions, history: fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE)) : [] });
    } catch (e) { res.status(500).send("Error"); }
});

refreshExchangeInfo();
setInterval(mainLoop, 5000);
APP.listen(9001);
