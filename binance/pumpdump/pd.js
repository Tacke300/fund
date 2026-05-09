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
const exchange = new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } });

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();
const BLACKLIST_DURATION = 15 * 60 * 1000;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

// ============ ĐỢI 5S VÀ ĐẶT LẠI TP/SL THEO YÊU CẦU ============
async function syncTPSL(symbol, side, entry, info) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        // 1. Dọn lệnh cũ
        const openOrders = await exchange.fetchOpenOrders(symbol);
        for (const o of openOrders) {
            if (o.info.positionSide === side) await exchange.cancelOrder(o.id, symbol, { positionSide: side });
        }

        // 2. Chờ 5s theo yêu cầu
        addBotLog(`⏳ [${symbol}] Đợi 5s xác nhận dọn sạch lệnh cũ...`);
        await new Promise(r => setTimeout(r, 5000));

        // 3. Kiểm tra lại lần nữa xem còn lệnh nào không
        const checkAgain = await exchange.fetchOpenOrders(symbol);
        const stillHas = checkAgain.some(o => o.info.positionSide === side);
        if (stillHas) {
             addBotLog(`⚠️ [${symbol}] Vẫn còn lệnh chờ, bỏ qua lượt đặt này để tránh lỗi.`, "warning");
             return { success: false };
        }

        // 4. Đặt mới
        const orderTP = await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE' });
        const orderSL = await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE' });

        addBotLog(`🎯 [${symbol}] Set TPSL mới: TP ${tpPrice} (ID: ${orderTP.id}) | SL ${slPrice} (ID: ${orderSL.id})`, "success");
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi TPSL: ${e.message}`, "error");
        return { success: false };
    }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        if (info.maxLeverage < 20) {
            status.blackList[symbol] = Date.now() + 300000; 
            return;
        }

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        let cp = botActivePositions.get(posKey);
        let marginToUse = 0;

        if (isDCA) {
            if (!cp || cp.isProcessing) return;
            cp.isProcessing = true;
            marginToUse = cp.firstMargin;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 5.5) qtyNum = Math.ceil(6.0 / currentPrice / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`✅ [${symbol}] Khớp Market ID: ${order.id}`);
            await new Promise(r => setTimeout(r, 3000));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realP = pRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const finalEntry = parseFloat(realP.entryPrice);
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, 
                    qty: currentQty, tp: sync.tp || 0, sl: sync.sl || 0, 
                    margin: (currentQty * finalEntry) / info.maxLeverage, // TRẢ VỀ CHO HTML
                    leverage: info.maxLeverage, // TRẢ VỀ CHO HTML
                    firstMargin: isDCA ? cp.firstMargin : marginToUse,
                    dcaCount: isDCA ? cp.dcaCount + 1 : 0, isProcessing: false, pnl: 0, markPrice: currentPrice
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi mở lệnh: ${e.message}`, "error");
        if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally {
        openingSymbols.delete(symbol);
    }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const exchangeKeys = new Set();

        for (const p of posRisk) {
            const amt = Math.abs(parseFloat(p.positionAmt));
            if (amt > 0) {
                const key = `${p.symbol}_${p.positionSide}`;
                exchangeKeys.add(key);
                const botPos = botActivePositions.get(key);
                if (botPos) {
                    botPos.markPrice = parseFloat(p.markPrice);
                    // PNL TRỪ PHÍ 0.1% TỔNG VOL
                    const rawPnl = parseFloat(p.unRealizedProfit);
                    const fee = (amt * botPos.markPrice) * 0.001; 
                    botPos.pnl = rawPnl - fee;
                    botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
                }
            }
        }

        for (let [key, botPos] of botActivePositions) {
            if (!exchangeKeys.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] Đã đóng. Blacklist 15p.`);
                status.blackList[botPos.symbol] = Date.now() + BLACKLIST_DURATION;
                botActivePositions.delete(key);
                // Cập nhật PnL tổng
                setTimeout(async () => {
                    const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: botPos.symbol, limit: 10 });
                    const recentPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
                    status.botPnLClosed += (recentPnL - (botPos.qty * botPos.entryPrice * 0.001));
                    status.botClosedCount++;
                }, 5000);
            }
        }
    } catch (e) { }
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return; // CHẶN STOP BOT
    try {
        for (let [key, botPos] of botActivePositions) {
            if (!botPos.isProcessing && botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
                await openPosition(botPos.symbol, true);
            }
        }
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const entry = status.candidatesList.find(c => {
                const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return volOK && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`);
            });
            if (entry) await openPosition(entry.symbol, false);
        }
    } catch (e) { }
}

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brkRes.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V21.2 - SYNC DCA & FEE FIXED", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        // CHUYỂN BLACKLIST VỀ DẠNG GIÂY (NUMBER) ĐỂ HTML CHẠY ĐƯỢC fmtTime
        const blSecs = {};
        const now = Date.now();
        Object.keys(status.blackList).forEach(s => {
            const rem = Math.floor((status.blackList[s] - now) / 1000);
            if (rem > 0) blSecs[s] = rem; else delete status.blackList[s];
        });

        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: blSecs }, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: (parseFloat(acc.totalUnrealizedProfit) - (Array.from(botActivePositions.values()).length * 0.1)).toFixed(2)
            }
        });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
