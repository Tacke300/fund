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
    isRunning: false, maxPositions: 3, invValue: 1, invType: 'percent', 
    minVol: 6.5, posTP: 0.5, posSL: 5.0,
    dcaStep: 2.0, // % âm để DCA
    maxDCA: 4     // Tối đa 4 lần DCA (Lần 5 sẽ là SL và đảo lệnh)
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

// Hàm mở lệnh đảo chiều LONG khi SHORT bị SL ở mốc 5
async function openHedgeLong(symbol, info, oldMargin) {
    try {
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        const lev = info.maxLeverage;
        let multiplier = 50;
        if (lev >= 50 && lev <= 74) multiplier = 100;
        else if (lev >= 75) multiplier = 150;

        const newMargin = oldMargin * multiplier;
        let notional = newMargin * lev;
        let qty = ((notional / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        const order = await exchange.createOrder(symbol, 'market', 'buy', qty, undefined, { positionSide: 'LONG' });
        if (order) {
            const entry = order.price || price;
            // TP = mốc dca 6 (tương đương 2 mốc dcaStep), SL = mốc dca 4 (lùi lại 1 mốc dcaStep)
            const tp = (entry * (1 + (botSettings.dcaStep * 2) / 100)).toFixed(info.pricePrecision);
            const sl = (entry * (1 - botSettings.dcaStep / 100)).toFixed(info.pricePrecision);

            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'sell', qty, undefined, { positionSide: 'LONG', stopPrice: tp, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', 'sell', qty, undefined, { positionSide: 'LONG', stopPrice: sl, closePosition: true })
            ]).catch(() => {});

            botActivePositions.set(`${symbol}_LONG`, { symbol, side: 'LONG', entryPrice: entry, qty, tp, sl, margin: newMargin, dcaCount: 99 });
            addBotLog(`🛡️ LONG PHÒNG HỘ | ${symbol} | Margin: ${newMargin}$ (x${multiplier}) | Entry: ${entry} | TP: ${tp} | SL: ${sl}`, "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi mở Long phòng hộ: ${e.message}`, "error"); }
}

async function openPosition(symbol, isDCA = false) {
    if (!isDCA && status.blackList[symbol] && Date.now() < status.blackList[symbol]) return;
    
    const info = status.exchangeInfo[symbol];
    const posKey = `${symbol}_SHORT`;
    let currentPos = botActivePositions.get(posKey);
    let dcaCount = isDCA ? (currentPos.dcaCount || 0) + 1 : 0;

    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const price = parseFloat((await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`)).data.price);
        
        // Quản lý vốn
        let baseInv = botSettings.invType === 'percent' ? (parseFloat(acc.availableBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        let margin = isDCA ? baseInv * Math.pow(1.5, dcaCount) : baseInv;

        let notional = Math.max(margin * info.maxLeverage, 5.5);
        let qty = ((notional / price) / info.stepSize * info.stepSize).toFixed(info.quantityPrecision);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qty, undefined, { positionSide: 'SHORT' });

        if (order) {
            const entry = order.price || price;
            const tp = (entry * (1 - botSettings.posTP / 100)).toFixed(info.pricePrecision);
            
            // LOGIC SL ĐẶC BIỆT: Nếu là DCA lần 4, SL đặt tại mốc DCA số 5
            let sl;
            if (dcaCount === 4) {
                sl = (entry * (1 + botSettings.dcaStep / 100)).toFixed(info.pricePrecision);
            } else {
                sl = (entry * (1 + botSettings.posSL / 100)).toFixed(info.pricePrecision);
            }

            if (isDCA) await exchange.cancelAllOrders(symbol).catch(() => {});

            await Promise.all([
                exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'buy', qty, undefined, { positionSide: 'SHORT', stopPrice: tp, closePosition: true }),
                exchange.createOrder(symbol, 'STOP_MARKET', 'buy', qty, undefined, { positionSide: 'SHORT', stopPrice: sl, closePosition: true })
            ]).catch(() => {});

            botActivePositions.set(posKey, { symbol, side: 'SHORT', entryPrice: entry, qty, tp, sl, margin, dcaCount, baseInv });
            addBotLog(`${isDCA ? `⚠️ DCA LẦN ${dcaCount}` : '🚀 MỞ SHORT'} | ${symbol} | Margin: ${margin.toFixed(2)}$ | Lev: x${info.maxLeverage} | Entry: ${entry} | TP: ${tp} | SL: ${sl}`, isDCA ? "warning" : "success");
        }
    } catch (e) { addBotLog(`❌ Lỗi mở/DCA: ${e.message}`, "error"); }
}

async function mainLoop() {
    if (!status.isReady) return;
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();

        // 1. Kiểm tra điều kiện Margin Safety
        const totalUsedMargin = parseFloat(acc.totalInitialMargin);
        const availableBalance = parseFloat(acc.availableBalance);
        const totalWallet = totalUsedMargin + availableBalance;
        const marginRatio = (totalUsedMargin / totalWallet) * 100;

        let canOpenNew = marginRatio < 50; 
        // Nếu đã ngưng, cần hồi về trên 60% (tức là used margin < 40% wallet) mới mở lại
        // Tuy nhiên theo ý bạn: Hồi lại "trên 60% số dư khả dụng" -> hiểu là available > 60% wallet
        if (!canOpenNew && (availableBalance / totalWallet) > 0.6) canOpenNew = true;

        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            if (!realPos || parseFloat(realPos.positionAmt) === 0) {
                // KIỂM TRA NẾU VỪA BỊ SL Ở LẦN DCA 4 -> MỞ LONG PHÒNG HỘ
                if (botPos.side === 'SHORT' && botPos.dcaCount === 4) {
                    addBotLog(`🔥 Chạm mốc DCA 5! Đóng Short và kích hoạt LONG PHÒNG HỘ cho ${botPos.symbol}`, "error");
                    await openHedgeLong(botPos.symbol, status.exchangeInfo[botPos.symbol], botPos.baseInv);
                }
                
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                botActivePositions.delete(key);
            } else {
                botPos.pnlPercent = parseFloat(realPos.unRealizedProfit) / (parseFloat(realPos.positionInitialMargin)) * 100;
                // DCA không bị chặn bởi luật 50% margin
                if (botPos.side === 'SHORT' && botPos.pnlPercent <= -botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) {
                    await openPosition(botPos.symbol, true);
                }
            }
        }

        // 2. Lọc kèo mới (Bị chặn bởi luật Margin Safety)
        if (botSettings.isRunning && canOpenNew && botActivePositions.size < botSettings.maxPositions) {
            const keo = status.candidatesList.find(c => {
                const isBlack = status.blackList[c.symbol] && now < status.blackList[c.symbol];
                const satisfiesVol = Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol || Math.abs(c.c15) >= botSettings.minVol;
                return !botActivePositions.has(`${c.symbol}_SHORT`) && !isBlack && satisfiesVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        } else if (!canOpenNew && botSettings.isRunning) {
            // Log cảnh báo margin nếu cần
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
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY v19.0 - HEDGE & SAFETY MODE - READY", "success");
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
