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
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1$", minVol: 6.5, posTP: 0.5, posSL: 1.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

// LOG CHI TIẾT (XUẤT RA PM2 VÀ UI)
function addBotLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    console.log(`[${time}] ${msg}`); // Xem trong pm2 logs
    status.botLogs.unshift({ time, msg });
    if (status.botLogs.length > 100) status.botLogs.pop();
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
    return response.data;
}

// ĐẶT TP/SL CHUẨN
async function syncTPSL(symbol, side, entry, info, qty, tpP, slP) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - tpP / 100) : (1 + tpP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slP / 100) : (1 - slP / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE' });
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: false, err: e.message };
    }
}

async function openPosition(symbol, dcaIteration = 0, isReverse = false, baseMargin = 1) {
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);
    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const curPrice = parseFloat(ticker.data.price);
        const candle = status.candidatesList.find(c => c.symbol === symbol) || { c1: 0, c5: 0, c15: 0 };

        const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const lev = parseInt(pRisk[0].leverage);

        let marginToUse = isReverse ? baseMargin * 50 : baseMargin * (dcaIteration === 0 ? 1 : (dcaIteration + 1) * 1.1);
        let side = isReverse ? 'LONG' : 'SHORT';
        
        let qtyNum = (marginToUse * lev) / curPrice;
        qtyNum = Math.floor(qtyNum / info.stepSize) * info.stepSize;
        const qtyStr = qtyNum.toFixed(info.quantityPrecision);

        // LOG CHI TIẾT KHI MỞ
        addBotLog(`🔥 MỞ LỆNH: ${symbol} | Side: ${side} | Margin: ${marginToUse}$ | Lev: x${lev} | Biến động: [1M:${candle.c1}% | 5M:${candle.c5}% | 15M:${candle.c15}%]`);

        await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qtyStr, undefined, { positionSide: side });

        await new Promise(r => setTimeout(r, 2000));
        const pRiskAfter = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realP = pRiskAfter.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (realP) {
            const entry = parseFloat(realP.entryPrice);
            const sync = await syncTPSL(symbol, side, entry, info, Math.abs(realP.positionAmt), botSettings.posTP, botSettings.posSL);
            
            addBotLog(`📍 Khớp ${symbol} @ ${entry} | TP: ${sync.tp} | SL: ${sync.sl} | Qty: ${realP.positionAmt}`);

            botActivePositions.set(`${symbol}_${side}`, { 
                symbol, side, entryPrice: entry, leverage: lev, 
                tp: sync.tp, sl: sync.sl, qty: Math.abs(realP.positionAmt), 
                dcaCount: dcaIteration, isReverse, firstMargin: baseMargin,
                tpslOk: sync.success, totalVol: Math.abs(realP.positionAmt) * entry
            });
        }
    } catch (e) { addBotLog(`🚨 Lỗi Mở: ${e.message}`); }
    finally { openingSymbols.delete(symbol); }
}

async function monitorLoop() {
    if (!status.isReady) return setTimeout(monitorLoop, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const p = posRisk.find(x => `${x.symbol}_${x.positionSide}` === key);
            
            // XỬ LÝ KHI VỊ THẾ ĐÃ ĐÓNG
            if (!p || Math.abs(parseFloat(p.positionAmt)) === 0) {
                // TÍNH PNL THỰC TẾ (TRỪ 0.1% PHÍ/TRƯỢT GIÁ)
                const rawPnL = botPos.lastPnL || 0;
                const fee = botPos.totalVol * 0.001; // 0.1% Volume
                const netPnL = rawPnL - fee;

                status.botPnLClosed += netPnL;
                status.botClosedCount++;
                addBotLog(`✅ ĐÓNG ${botPos.symbol} | PnL Gốc: ${rawPnL.toFixed(2)}$ | Phí: -${fee.toFixed(2)}$ | PnL Thực: ${netPnL.toFixed(2)}$`);

                botActivePositions.delete(key);
                
                // Logic DCA/Reverse
                const markPrice = p ? parseFloat(p.markPrice) : 0;
                const isLoss = botPos.side === 'SHORT' ? markPrice > botPos.entryPrice : markPrice < botPos.entryPrice;
                if (isLoss && !botPos.isReverse) {
                    if (botPos.dcaCount + 1 < botSettings.maxDCA) openPosition(botPos.symbol, botPos.dcaCount + 1, false, botPos.firstMargin);
                    else openPosition(botPos.symbol, 0, true, botPos.firstMargin);
                } else {
                    status.blackList[botPos.symbol] = Date.now() + 900000;
                }
                continue;
            }

            // CẬP NHẬT TRẠNG THÁI LIÊN TỤC
            botPos.lastPnL = parseFloat(p.unRealizedProfit);
            botPos.pnl = botPos.lastPnL;
            botPos.priceDev = ((parseFloat(p.markPrice) - botPos.entryPrice) / botPos.entryPrice) * 100;

            // KIỂM TRA ĐẶT LẠI TP/SL NẾU THIẾU
            if (!botPos.tpslOk) {
                const info = status.exchangeInfo[botPos.symbol];
                const retry = await syncTPSL(botPos.symbol, botPos.side, botPos.entryPrice, info, botPos.qty, botSettings.posTP, botSettings.posSL);
                if (retry.success) {
                    botPos.tpslOk = true;
                    addBotLog(`🔄 Đã đặt lại TP/SL cho ${botPos.symbol}`);
                }
            }

            // FORCE CLOSE KHI GIÁ VƯỢT NGƯỠNG
            const markPrice = parseFloat(p.markPrice);
            const isShort = botPos.side === 'SHORT';
            const hitTP = isShort ? markPrice <= botPos.tp : markPrice >= botPos.tp;
            const hitSL = isShort ? markPrice >= botPos.sl : markPrice <= botPos.sl;

            if (hitTP || hitSL) {
                addBotLog(`⚡ Force Close ${botPos.symbol} do chạm ngưỡng giá.`);
                try {
                    await exchange.createOrder(botPos.symbol, 'MARKET', isShort ? 'BUY' : 'SELL', botPos.qty, undefined, { positionSide: botPos.side });
                    botActivePositions.delete(key);
                } catch (err) {}
            }
        }
    } catch (e) {}
    setTimeout(monitorLoop, 1000); 
}

// SCANNER & EXPRESS (GIỮ NGUYÊN)
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        status.exchangeInfo = Object.fromEntries(infoRes.data.symbols.map(s => [s.symbol, { 
            quantityPrecision: s.quantityPrecision, 
            pricePrecision: s.pricePrecision, 
            stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize) 
        }]));
        status.isReady = true; monitorLoop();
        addBotLog("🚀 LUFFY BOT STARTED...");
    } catch (e) { setTimeout(init, 5000); }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: Object.fromEntries(Object.entries(status.blackList).map(([s, t]) => [s, Math.max(0, Math.floor((t - Date.now())/1000))])) },
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance).toFixed(2),
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2)
            }
        });
    } catch (e) { res.json({ botSettings, activePositions: [], status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001); init();

setInterval(() => {
    if (status.isReady && botSettings.isRunning && botActivePositions.size < botSettings.maxPositions) {
        const entry = status.candidatesList.find(c => Math.abs(c.c1) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (entry) openPosition(entry.symbol, 0, false, parseFloat(botSettings.invValue.replace('$','')));
    }
}, 4000);
