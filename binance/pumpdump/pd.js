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

// CẤU HÌNH CCXT TỰ ĐỘNG FIX LỆCH GIỜ
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

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, canOpenNew: true };
let botActivePositions = new Map();
let lastErrorLog = ""; 
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

async function syncTPSL(symbol, side, qty, entry, dcaCount, info, force = false) {
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        const targetOrders = orders.filter(o => o.positionSide === side && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET'));
        
        const tpPrice = (entry * (side === 'SHORT' ? (1 - botSettings.posTP / 100) : (1 + (botSettings.dcaStep * 2) / 100))).toFixed(info.pricePrecision);
        let slPrice = (dcaCount === 4) ? (entry * (1 + botSettings.dcaStep / 100)) : (entry * (1 + botSettings.posSL / 100));
        if (side === 'LONG') slPrice = (entry * (1 - botSettings.dcaStep / 100));
        slPrice = parseFloat(slPrice).toFixed(info.pricePrecision);

        if (force || targetOrders.length < 2) {
            for (const old of targetOrders) { await exchange.cancelOrder(old.id || old.orderId, symbol).catch(() => {}); }
            if (force) await new Promise(r => setTimeout(r, 2500));
            const sideClose = side === 'SHORT' ? 'buy' : 'sell';
            
            try {
                await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true });
                await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true });
            } catch (err) {
                addBotLog(`⚠️ Lỗi đặt TP/SL ${symbol}: ${err.message}. Chế độ bảo vệ giá đang chạy.`, "warning");
            }
            return { tp: Number(tpPrice), sl: Number(slPrice) };
        }
        return { tp: Number(targetOrders.find(o => o.type === 'TAKE_PROFIT_MARKET')?.stopPrice), sl: Number(targetOrders.find(o => o.type === 'STOP_MARKET')?.stopPrice) };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

async function openPosition(symbol, isDCA = false, candidateData = null) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && botActivePositions.has(posKey)) return;
    if (isDCA && botActivePositions.get(posKey)?.isProcessing) return;

    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const available = parseFloat(acc.availableBalance);
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        let margin = isDCA ? (botActivePositions.get(posKey).margin * 1.03) : (available * parseFloat(botSettings.invValue) / 100);

        if (isDCA) botActivePositions.get(posKey).isProcessing = true;
        else botActivePositions.set(posKey, { symbol, isProcessing: true });

        let qty = (Math.floor((margin * info.maxLeverage / price) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty, undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2500));
            const upPos = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            const dcaCount = isDCA ? botActivePositions.get(posKey).dcaCount + 1 : 0;

            const sync = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, dcaCount, info, true);
            addBotLog(`${isDCA ? '⚠️ DCA' : '🚀 OPEN'} | ${symbol} | Entry:${avgEntry} | TP:${sync.tp}`, isDCA ? "warning" : "success");
            
            botActivePositions.set(posKey, { symbol, side: 'SHORT', entryPrice: avgEntry, qty: totalQty, tp: sync.tp, sl: sync.sl, margin, dcaCount, lastUpdate: Date.now(), isProcessing: false });
        }
    } catch (e) {
        addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error");
        if (e.message.toLowerCase().includes("margin")) status.blackList[symbol] = Date.now() + (15 * 60 * 1000);
        if (!isDCA) botActivePositions.delete(posKey);
        else if (botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    }
}

// ========================================================
// CHỨC NĂNG THEO DÕI GIÁ VÀ TỰ ĐỘNG ĐÓNG MARKET (1 GIÂY/LẦN)
// ========================================================
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // 1. Nếu vị thế đã biến mất trên sàn (khớp TP/SL sàn)
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                addBotLog(`✅ CLOSE | ${botPos.symbol} | Khớp sàn thành công`, "success");
                botActivePositions.delete(key);
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                continue;
            }

            // 2. Chốt chặn cuối: Tự động đóng Market nếu giá chạm ngưỡng mà sàn chưa xử lý
            const markPrice = parseFloat(realPos.markPrice);
            const hitTP = botPos.tp > 0 && markPrice <= botPos.tp; // SHORT thì giá giảm là TP
            const hitSL = botPos.sl > 0 && markPrice >= botPos.sl; // SHORT thì giá tăng là SL

            if (hitTP || hitSL) {
                botPos.isProcessing = true;
                const reason = hitTP ? `TP (${botPos.tp})` : `SL (${botPos.sl})`;
                addBotLog(`🚨 EMERGENCY | ${botPos.symbol} chạm ${reason} | Mark: ${markPrice} | Bot tự đóng Market ngay!`, "warning");
                
                try {
                    await exchange.createOrder(botPos.symbol, 'market', 'buy', Math.abs(parseFloat(realPos.positionAmt)), undefined, { positionSide: 'SHORT' });
                    addBotLog(`🔥 FORCE CLOSED | ${botPos.symbol} thành công.`, "success");
                    botActivePositions.delete(key);
                    status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                } catch (err) {
                    addBotLog(`❌ CRITICAL: Không thể đóng Market ${botPos.symbol}: ${err.message}`, "error");
                    botPos.isProcessing = false;
                }
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

            // Cập nhật TP/SL sàn định kỳ 30s một lần
            if (now - botPos.lastUpdate > 30000) {
                const sync = await syncTPSL(botPos.symbol, 'SHORT', Math.abs(parseFloat(realPos.positionAmt)), parseFloat(realPos.entryPrice), botPos.dcaCount, status.exchangeInfo[botPos.symbol]);
                botPos.tp = sync.tp;
                botPos.sl = sync.sl;
                botPos.lastUpdate = now;
            }

            // Check DCA
            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
        }

        // Quét kèo mới
        if (botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const v = [c.c1, c.c5, c.c15].map(x => Math.abs(parseFloat(x)));
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !(status.blackList[c.symbol] > now) && v.some(val => val >= parseFloat(botSettings.minVol));
            });
            if (keo) await openPosition(keo.symbol, false, keo);
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
        addBotLog("👿 LUFFY v21.16 - EMERGENCY CHOP - READY", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3500);
setInterval(syncTime, 60000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
