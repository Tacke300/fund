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

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 20000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, options: { defaultType: 'future', dualSidePosition: true } });

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: 1, 
    invType: 'percent', 
    minVol: 6.5, 
    posTP: 0.5, 
    posSL: 5.0,
    dcaStep: 2.0, // Âm 2% thì DCA
    maxDCA: 3 
};

let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {} };
let botActivePositions = new Map(); 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
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

async function openPosition(symbol, isDCA = false, candles = {c1:0, c5:0, c15:0}) {
    if (!isDCA && status.blackList[symbol] && Date.now() < status.blackList[symbol]) return;
    
    const info = status.exchangeInfo[symbol];
    const posKey = `${symbol}_SHORT`;
    let currentPosData = botActivePositions.get(posKey);
    let dcaCount = isDCA ? (currentPosData.dcaCount || 0) + 1 : 0;

    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const marketPrice = parseFloat(ticker.data.price);
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.availableBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        if (isDCA) margin = margin * Math.pow(1.5, dcaCount); 

        let notional = Math.max(margin * info.maxLeverage, 6.0);
        let qty = ((notional / marketPrice) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty, undefined, { positionSide: 'SHORT' });

        if (order) {
            // Lấy dữ liệu vị thế thực tế từ sàn để có Entry trung bình chính xác
            const positions = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = positions.find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(realPos.entryPrice);
            
            const tp = (avgEntry * (1 - botSettings.posTP / 100)).toFixed(info.pricePrecision);
            const sl = (avgEntry * (1 + botSettings.posSL / 100)).toFixed(info.pricePrecision);

            if (isDCA) await exchange.cancelAllOrders(symbol).catch(() => {});

            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'buy', realPos.positionAmt.replace('-',''), undefined, { positionSide: 'SHORT', stopPrice: tp, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', 'buy', realPos.positionAmt.replace('-',''), undefined, { positionSide: 'SHORT', stopPrice: sl, closePosition: true })
            ]).catch(() => {});

            botActivePositions.set(posKey, { 
                symbol, side: 'SHORT', entryPrice: avgEntry, qty: realPos.positionAmt, tp, sl, 
                margin: margin.toFixed(2), lev: info.maxLeverage, dcaCount 
            });

            if (isDCA) {
                addBotLog(`⚠️ DCA LẦN ${dcaCount} | ${symbol} | Giá DCA: ${marketPrice} | Entry mới: ${avgEntry} | TP: ${tp} | SL: ${sl}`, "warning");
            } else {
                addBotLog(`🚀 MỞ SHORT | ${symbol} | [1m:${candles.c1}% 5m:${candles.c5}% 15m:${candles.c15}%] | Entry: ${avgEntry} | Margin: ${margin.toFixed(2)}$ | Lev: x${info.maxLeverage} | TP: ${tp} | SL: ${sl}`, "success");
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi ${isDCA ? 'DCA' : 'Mở'}: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            if (!realPos || parseFloat(realPos.positionAmt) === 0) {
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                addBotLog(`🔒 ${botPos.symbol} đóng. Khóa 15p.`, "info");
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice);
                // Tính PNL thực tế dựa trên entry và giá mark
                const pnl = ((avgEntry - botPos.markPrice) / avgEntry) * botPos.lev * 100; 
                // Nhưng Binance trả về unRealizedProfit, dùng nó chia cho ký quỹ để chính xác hơn
                const pnlReal = (parseFloat(realPos.unRealizedProfit) / parseFloat(realPos.positionInitialMargin)) * 100;

                if (pnlReal <= -botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) {
                    await openPosition(botPos.symbol, true);
                }
            }
        }

        Object.keys(status.blackList).forEach(sym => { if (now > status.blackList[sym]) delete status.blackList[sym]; });

        if (botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const isBlack = status.blackList[c.symbol] && now < status.blackList[c.symbol];
                const satisfiesVol = Math.abs(c.c1) >= botSettings.minVol || 
                                     Math.abs(c.c5) >= botSettings.minVol || 
                                     Math.abs(c.c15) >= botSettings.minVol;

                return !botActivePositions.has(`${c.symbol}_SHORT`) && !isBlack && satisfiesVol;
            });
            
            if (keo) await openPosition(keo.symbol, false, {c1: keo.c1, c5: keo.c5, c15: keo.c15});
        }
    } catch (e) {}
}

async function init() {
    try {
        await exchange.setPositionMode(true).catch(() => {});
        const [infoRes, brkRes] = await Promise.all([binanceApi.get('/fapi/v1/exchangeInfo'), binancePrivate('/fapi/v1/leverageBracket')]);
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY v18.6 (FULL LOG MODE) - READY", "success");
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3500);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express();
APP.use(express.json());
APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
