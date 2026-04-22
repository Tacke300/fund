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

// CẤU HÌNH MẶC ĐỊNH
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

// 1. ĐỒNG BỘ THỜI GIAN
async function syncTime() {
    try {
        const start = Date.now();
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time');
        const serverTime = res.data.serverTime;
        const end = Date.now();
        timestampOffset = serverTime - Math.floor((start + end) / 2);
    } catch (e) { console.error("⚠️ Lỗi đồng bộ thời gian:", e.message); }
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) { await syncTime(); }
        throw new Error(error.response?.data?.msg || error.message);
    }
}

// 2. ĐẶT TP/SL VÀ ĐỢI 3S
async function syncTPSL(symbol, side, qty, entry, dcaCount, info, force = false) {
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        const targetOrders = orders.filter(o => o.positionSide === side && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'STOP_MARKET'));

        const tpPrice = (entry * (side === 'SHORT' ? (1 - botSettings.posTP / 100) : (1 + (botSettings.dcaStep * 2) / 100))).toFixed(info.pricePrecision);
        let slPrice = (dcaCount === 4) ? (entry * (1 + botSettings.dcaStep / 100)) : (entry * (1 + botSettings.posSL / 100));
        if (side === 'LONG') slPrice = (entry * (1 - botSettings.dcaStep / 100)).toFixed(info.pricePrecision);
        slPrice = Number(slPrice).toFixed(info.pricePrecision);

        const currentTP = targetOrders.find(o => o.type === 'TAKE_PROFIT_MARKET');
        const currentSL = targetOrders.find(o => o.type === 'STOP_MARKET');

        const needUpdate = force || !currentTP || !currentSL || (Math.abs(parseFloat(currentTP.stopPrice) - parseFloat(tpPrice)) / tpPrice > 0.001);

        if (needUpdate) {
            for (const old of targetOrders) { await exchange.cancelOrder(old.orderId, symbol).catch(() => {}); }
            if (force) await new Promise(r => setTimeout(r, 3000));

            const sideClose = side === 'SHORT' ? 'buy' : 'sell';
            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true })
            ]);
            return { tp: tpPrice, sl: slPrice };
        }
        return { tp: currentTP?.stopPrice, sl: currentSL?.stopPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

// 3. MỞ LỆNH VÀ DCA
async function openPosition(symbol, isDCA = false, candidateData = null) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && botActivePositions.has(posKey)) return;
    let currentPos = botActivePositions.get(posKey);
    if (isDCA && currentPos?.isProcessing) return;

    try {
        const info = status.exchangeInfo[symbol];
        let acc;
        try { acc = await binancePrivate('/fapi/v2/account'); } catch (e) { return; } // Lỗi mạng không chặn blacklist
        
        const available = parseFloat(acc.availableBalance);
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        let baseMargin = (available * parseFloat(botSettings.invValue)) / 100;
        let margin = isDCA ? (currentPos.margin * 1.03) : baseMargin;

        if (margin * info.maxLeverage < 5.1) {
            addBotLog(`⚠️ ${symbol}: Thiếu Margin (< 5.1). Chặn 15p.`, "warning");
            status.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
            if (!isDCA) botActivePositions.delete(posKey);
            return;
        }

        if (isDCA) currentPos.isProcessing = true;
        else botActivePositions.set(posKey, { symbol, isProcessing: true });

        let qty = ((margin * info.maxLeverage / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty, undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const upPos = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            const dcaCount = isDCA ? currentPos.dcaCount + 1 : 0;

            const sync = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, dcaCount, info, true);
            
            if (isDCA) {
                addBotLog(`⚠️ DCA ${dcaCount} | ${symbol} | Entry:${avgEntry} | TP:${sync.tp}`, "warning");
            } else {
                const vol = candidateData ? `1m:${candidateData.c1}% 5m:${candidateData.c5}% 15m:${candidateData.c15}%` : "";
                addBotLog(`🚀 OPEN | ${symbol} | Entry:${avgEntry} | TP:${sync.tp} | SL:${sync.sl} | Vol:${vol}`, "success");
            }
            botActivePositions.set(posKey, { symbol, side: 'SHORT', entryPrice: avgEntry, qty: totalQty, tp: Number(sync.tp), sl: Number(sync.sl), margin, dcaCount, baseInv: isDCA ? currentPos.baseInv : baseMargin, lastUpdate: Date.now(), isProcessing: false });
        }
    } catch (e) {
        addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error");
        if (!isDCA) botActivePositions.delete(posKey);
        else if (botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    }
}

// 4. THEO DÕI GIÁ TỪNG GIÂY (CHỐT CHẶN CUỐI)
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // Nếu sàn đã khớp TP/SL
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                addBotLog(`✅ ĐÃ ĐÓNG | ${botPos.symbol} | Khớp lệnh sàn`, "success");
                const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: botPos.symbol });
                for (const o of orders.filter(o => o.positionSide === botPos.side)) { await exchange.cancelOrder(o.orderId, botPos.symbol).catch(() => {}); }
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                botActivePositions.delete(key);
                continue;
            }

            const markPrice = parseFloat(realPos.markPrice);
            const isTPHit = botPos.tp > 0 && markPrice <= botPos.tp; 
            const isSLHit = botPos.sl > 0 && markPrice >= botPos.sl; 

            // Nếu giá vượt ngưỡng mà sàn chưa đóng -> Bot tự xử
            if (isTPHit || isSLHit) {
                botPos.isProcessing = true;
                const type = isTPHit ? "TP" : "SL";
                const target = isTPHit ? botPos.tp : botPos.sl;
                addBotLog(`🚨 CHẠM ${type} (${target}) | ${botPos.symbol} | Mark:${markPrice} | Đang đóng Market...`, "warning");

                try {
                    await exchange.createOrder(botPos.symbol, 'market', botPos.side === 'SHORT' ? 'buy' : 'sell', Math.abs(parseFloat(realPos.positionAmt)), undefined, { positionSide: botPos.side });
                    addBotLog(`🔥 ĐÓNG THÀNH CÔNG | ${botPos.symbol} | Xử lý bởi Bot`, "success");
                    botActivePositions.delete(key);
                    status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                } catch (err) {
                    addBotLog(`❌ LỖI ĐÓNG LỆNH: ${err.message}`, "error");
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
            if (botPos.isProcessing) continue;
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) continue;

            if (now - botPos.lastUpdate > 30000) {
                await syncTPSL(botPos.symbol, botPos.side, Math.abs(parseFloat(realPos.positionAmt)), parseFloat(realPos.entryPrice), botPos.dcaCount, status.exchangeInfo[botPos.symbol]);
                botPos.lastUpdate = now;
            }

            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (botPos.side === 'SHORT' && priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
        }

        if (botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const v = [c.c1, c.c5, c.c15].map(x => Math.abs(parseFloat(x)));
                const minV = parseFloat(botSettings.minVol);
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !(status.blackList[c.symbol] > now) && v.some(val => val >= minV);
            });
            if (keo) await openPosition(keo.symbol, false, keo);
        }
    } catch (e) {}
}

async function init() {
    try {
        await syncTime();
        await exchange.setPositionMode(true).catch(() => {});
        const [infoRes, brkRes] = await Promise.all([binanceApi.get('/fapi/v1/exchangeInfo'), binancePrivate('/fapi/v1/leverageBracket')]);
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY v21.14 - FINAL - READY", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3500);
setInterval(syncTime, 300000);
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
