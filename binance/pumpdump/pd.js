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

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, canOpenNew: true };
let botActivePositions = new Map();
let timestampOffset = 0; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = res.data.serverTime - Date.now();
    } catch (e) {}
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

async function syncTPSL(symbol, side, qty, entry, dcaCount, info) {
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        // Logic tính toán TP/SL dựa trên entry trung bình
        const tpPrice = (entry * (side === 'SHORT' ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
        let slPrice = (side === 'SHORT') 
            ? (entry * (1 + botSettings.posSL / 100)) 
            : (entry * (1 - botSettings.posSL / 100));
        slPrice = parseFloat(slPrice).toFixed(info.pricePrecision);

        const sideClose = side === 'SHORT' ? 'buy' : 'sell';
        
        await Promise.all([
            exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true }),
            exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true })
        ]);
        
        return { tp: Number(tpPrice), sl: Number(slPrice) };
    } catch (e) {
        addBotLog(`⚠️ Lỗi đặt TP/SL ${symbol}: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && botActivePositions.has(posKey)) return;
    
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const available = parseFloat(acc.availableBalance);
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        let inputVal = botSettings.invValue.toString();
        let targetMargin = inputVal.includes('%') ? (available * parseFloat(inputVal) / 100) : parseFloat(inputVal);
        
        if (isDCA) {
            const currentPos = botActivePositions.get(posKey);
            if (!currentPos) return;
            targetMargin = currentPos.margin * 1.05;
            currentPos.isProcessing = true;
        } else {
            botActivePositions.set(posKey, { symbol, isProcessing: true, margin: targetMargin, dcaCount: 0, startTime: Date.now() });
        }

        let qtyNum = Math.ceil((targetMargin * info.maxLeverage / price) / info.stepSize) * info.stepSize;
        while ((qtyNum * price) < 5.2) { qtyNum += info.stepSize; }

        if ((qtyNum * price / info.maxLeverage) > available) {
            if (!isDCA) botActivePositions.delete(posKey);
            return;
        }

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const upPos = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            const dcaCount = isDCA ? botActivePositions.get(posKey).dcaCount + 1 : 0;
            const startTime = isDCA ? botActivePositions.get(posKey).startTime : Date.now();

            const sync = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, dcaCount, info);

            const logMsg = `${isDCA ? '⚠️ DCA' : '🚀 OPEN'} | ${symbol} | Qty:${totalQty} | AvgEntry:${avgEntry} | TP:${sync.tp} | SL:${sync.sl} | DCA:${dcaCount}`;
            addBotLog(logMsg, isDCA ? "warning" : "success");

            botActivePositions.set(posKey, { 
                symbol, side: 'SHORT', entryPrice: avgEntry, qty: totalQty, 
                tp: sync.tp, sl: sync.sl, margin: (totalQty * avgEntry / info.maxLeverage), 
                dcaCount, lastUpdate: Date.now(), startTime: startTime, isProcessing: false,
                leverage: info.maxLeverage
            });
        }
    } catch (e) {
        addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error");
        if (botActivePositions.has(posKey)) {
            if (isDCA) botActivePositions.get(posKey).isProcessing = false;
            else botActivePositions.delete(posKey);
        }
    }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // KIỂM TRA VỊ THẾ ĐÃ ĐÓNG
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) < (status.exchangeInfo[botPos.symbol].stepSize)) {
                addBotLog(`✅ CLOSE | ${botPos.symbol} | Chặn 15p`, "success");
                
                // THỰC HIỆN BLACKLIST 15 PHÚT
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000); 
                
                botActivePositions.delete(key);
                continue;
            }

            // Cập nhật PnL thời gian thực vào Map để API lấy
            botPos.unrealizedProfit = realPos.unRealizedProfit;
            botPos.liquidationPrice = realPos.liquidationPrice;

            const markPrice = parseFloat(realPos.markPrice);
            if ((botPos.tp > 0 && markPrice <= botPos.tp) || (botPos.sl > 0 && markPrice >= botPos.sl)) {
                botPos.isProcessing = true;
                await exchange.createOrder(botPos.symbol, 'market', 'buy', Math.abs(parseFloat(realPos.positionAmt)), undefined, { positionSide: 'SHORT' });
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || botPos.isProcessing) continue;

            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) {
                await openPosition(botPos.symbol, true);
            }
        }

        if (botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                if (!info || info.maxLeverage < 20) return false;
                const v = [c.c1, c.c5, c.c15].map(x => Math.abs(parseFloat(x)));
                
                // KIỂM TRA BLACKLIST TRƯỚC KHI MỞ
                const isBlacklisted = status.blackList[c.symbol] && status.blackList[c.symbol] > now;
                
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !isBlacklisted && v.some(val => val >= parseFloat(botSettings.minVol));
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        await syncTime();
        await exchange.loadMarkets();
        await exchange.setPositionMode(true).catch(() => {});
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY v21.24 - FULL INFO & BLACKLIST FIXED", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3000);
setInterval(syncTime, 60000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

// API STATUS TRẢ VỀ ĐẦY ĐỦ THÔNG TIN CHI TIẾT
APP.get('/api/status', (req, res) => {
    const positions = Array.from(botActivePositions.values()).map(p => ({
        coin: p.symbol,
        lev: p.leverage || 'N/A',
        side: p.side,
        entry: p.entryPrice.toFixed(status.exchangeInfo[p.symbol].pricePrecision),
        tp: p.tp,
        sl: p.sl,
        dca: p.dcaCount,
        margin: p.margin.toFixed(2),
        time: new Date(p.startTime).toLocaleString('vi-VN'),
        pnl: p.unrealizedProfit ? parseFloat(p.unrealizedProfit).toFixed(2) : "0.00"
    }));

    res.json({ 
        botSettings, 
        activePositions: positions, 
        status: {
            ...status,
            // Chỉ trả về các coin đang bị chặn để theo dõi trên giao diện
            blackListCount: Object.keys(status.blackList).filter(k => status.blackList[k] > Date.now()).length
        } 
    });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
