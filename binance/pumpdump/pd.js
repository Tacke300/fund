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

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, canOpenNew: true };
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

// HÀM KIỂM TRA VÀ CÀI BỔ SUNG TP/SL (CHỈ CÀI CÁI THIẾU)
async function syncTPSL(symbol, side, qty, entry, dcaCount, info) {
    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
    const posOrders = orders.filter(o => o.positionSide === side);
    
    const hasTP = posOrders.some(o => o.type === 'TAKE_PROFIT_MARKET');
    const hasSL = posOrders.some(o => o.type === 'STOP_MARKET');

    const tpPrice = (entry * (side === 'SHORT' ? (1 - botSettings.posTP / 100) : (1 + (botSettings.dcaStep*2) / 100))).toFixed(info.pricePrecision);
    let slPrice = (dcaCount === 4) ? (entry * (1 + botSettings.dcaStep / 100)) : (entry * (1 + botSettings.posSL / 100));
    if (side === 'LONG') slPrice = entry * (1 - botSettings.dcaStep / 100);
    slPrice = slPrice.toFixed(info.pricePrecision);

    const sideClose = side === 'SHORT' ? 'buy' : 'sell';

    if (!hasTP) {
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true }).catch(() => {});
    }
    if (!hasSL) {
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true }).catch(() => {});
    }
    return { tp: tpPrice, sl: slPrice };
}

async function openPosition(symbol, isDCA = false, candidateData = null) {
    const posKey = `${symbol}_SHORT`;
    let currentPos = botActivePositions.get(posKey);
    if (isDCA && currentPos?.isProcessing) return;

    try {
        // KIỂM TRA VỊ THẾ THỰC TẾ TRƯỚC KHI ĐẶT LỆNH MARKET
        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realPos = posRisk.find(p => p.positionSide === 'SHORT');
        const hasPos = realPos && Math.abs(parseFloat(realPos.positionAmt)) > 0;

        // Nếu không phải DCA mà sàn đã có lệnh -> Chỉ đồng bộ bộ nhớ, KHÔNG mở thêm
        if (!isDCA && hasPos) {
            botActivePositions.set(posKey, { symbol, side: 'SHORT', entryPrice: parseFloat(realPos.entryPrice), qty: Math.abs(parseFloat(realPos.positionAmt)), dcaCount: 0, lastUpdate: Date.now(), isProcessing: false });
            return;
        }

        if (isDCA) currentPos.isProcessing = true;
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        let baseMargin = isDCA ? currentPos.baseInv : ((parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue)) / 100);
        let margin = isDCA ? (currentPos.margin * 1.5) : baseMargin;
        let qty = ((margin * info.maxLeverage / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty, undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 1500)); // Chờ sàn cập nhật entry trung bình
            const upPos = (await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol })).find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            const dcaCount = isDCA ? currentPos.dcaCount + 1 : 0;

            const { tp, sl } = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, dcaCount, info);
            botActivePositions.set(posKey, { symbol, side: 'SHORT', entryPrice: avgEntry, qty: totalQty, tp, sl, margin, dcaCount, baseInv: baseMargin, lastUpdate: Date.now(), isProcessing: false });
            addBotLog(isDCA ? `⚠️ DCA ${dcaCount} | ${symbol} | Entry: ${avgEntry} | TP: ${tp} | SL: ${sl}` : `🚀 OPEN | ${symbol} | Entry: ${avgEntry} | TP: ${tp}`, isDCA ? "warning" : "success");
        }
    } catch (e) { 
        if (isDCA && currentPos) currentPos.isProcessing = false;
        addBotLog(`❌ Lỗi ${symbol}: ${e.message}`, "error"); 
    }
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // 1. Kiểm tra vị thế còn không
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                await exchange.cancelAllOrders(botPos.symbol).catch(() => {});
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                botActivePositions.delete(key);
                addBotLog(`✅ CLOSE | ${botPos.symbol}`, "info");
                continue;
            }

            // 2. Kiểm tra thiếu TP hoặc SL (sau 20s) - Cài bổ sung
            if (now - botPos.lastUpdate > 20000) {
                const { tp, sl } = await syncTPSL(botPos.symbol, botPos.side, Math.abs(parseFloat(realPos.positionAmt)), parseFloat(realPos.entryPrice), botPos.dcaCount, status.exchangeInfo[botPos.symbol]);
                botPos.tp = tp; botPos.sl = sl;
                botPos.lastUpdate = now;
            }

            // 3. Logic DCA 10% Giá
            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (botPos.side === 'SHORT' && priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
        }

        // 4. Mở lệnh mới
        const marginRatio = (parseFloat(acc.totalInitialMargin) / parseFloat(acc.totalWalletBalance)) * 100;
        if (botSettings.isRunning && marginRatio < 45 && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const isBlack = status.blackList[c.symbol] && now < status.blackList[c.symbol];
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !isBlack && (Math.abs(c.c1) >= botSettings.minVol);
            });
            if (keo) await openPosition(keo.symbol, false, keo);
        }
        Object.keys(status.blackList).forEach(sym => { if (now > status.blackList[sym]) delete status.blackList[sym]; });
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
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY v20.1 - SAFETY SYNC - READY", "success");
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 4000);
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
