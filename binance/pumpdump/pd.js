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

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set(); 

// --- UTILS ---
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
        const response = await binanceApi({ 
            method, 
            url: `${endpoint}?${query}${method !== 'GET' ? '' : ''}&signature=${signature}`,
            data: method !== 'GET' ? query + `&signature=${signature}` : null 
        });
        return response.data;
    } catch (error) {
        const apiError = error.response?.data || { msg: error.message, code: 0 };
        if (apiError.code === -1021) await syncTime();
        throw apiError; 
    }
}

// --- CORE LOGIC: AMEND TPSL (SỬA LỆNH) ---

/**
 * Tìm và cập nhật (PUT) lệnh TP/SL hiện có hoặc đặt mới nếu không tìm thấy.
 */
async function syncOrAmendTPSL(symbol, side, entry, info) {
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    try {
        // 1. Lấy danh sách lệnh chờ hiện tại
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        
        // 2. Phân loại lệnh TP và SL
        const oldTP = openOrders.find(o => o.type === 'TAKE_PROFIT_MARKET' && o.positionSide === side);
        const oldSL = openOrders.find(o => o.type === 'STOP_MARKET' && o.positionSide === side);

        // 3. Xử lý Take Profit (Sửa nếu có, tạo nếu không)
        if (oldTP) {
            await binancePrivate('/fapi/v1/order', 'PUT', {
                symbol, side: sideClose, orderId: oldTP.orderId, stopPrice: tpPrice, positionSide: side
            }).catch(() => {}); 
        } else {
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose.toLowerCase(), undefined, undefined, { 
                positionSide: side, stopPrice: tpPrice, closePosition: true 
            });
        }

        // 4. Xử lý Stop Loss (Sửa nếu có, tạo nếu không)
        if (oldSL) {
            await binancePrivate('/fapi/v1/order', 'PUT', {
                symbol, side: sideClose, orderId: oldSL.orderId, stopPrice: slPrice, positionSide: side
            }).catch(() => {});
        } else {
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose.toLowerCase(), undefined, undefined, { 
                positionSide: side, stopPrice: slPrice, closePosition: true 
            });
        }

        addBotLog(`🔄 [${symbol}] Cập nhật TP/SL thành công (Entry mới: ${entry})`, "success");
        return { tp: Number(tpPrice), sl: Number(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi đồng bộ TP/SL: ${e.msg || e.message}`, "error");
        throw e;
    }
}

// --- TRADING FUNCTIONS ---

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const currentPrice = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).then(res => parseFloat(res.data.price));
        
        let currentPos = botActivePositions.get(posKey);
        let marginToUse = 0, currentDCA = 0, firstMargin = 0;

        if (isDCA && currentPos) {
            currentPos.isProcessing = true; 
            firstMargin = currentPos.firstMargin;
            marginToUse = firstMargin * 1.1; // DCA mạnh hơn một chút để kéo entry
            currentDCA = currentPos.dcaCount + 1;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`🚀 [${symbol}] Khớp ${isDCA ? 'DCA #' + currentDCA : 'OPEN'}. Chờ cập nhật...`);
            await new Promise(r => setTimeout(r, 3500)); 

            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            
            if (upPos && Math.abs(parseFloat(upPos.positionAmt)) > 0) {
                const finalEntry = parseFloat(upPos.entryPrice);
                const finalQty = Math.abs(parseFloat(upPos.positionAmt));

                // SỬA LỆNH (PUT) THAY VÌ HỦY
                const sync = await syncOrAmendTPSL(symbol, 'SHORT', finalEntry, info);
                
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: finalQty, tp: sync.tp, sl: sync.sl, 
                    margin: (finalQty * finalEntry / info.maxLeverage), firstMargin, dcaCount: currentDCA, 
                    isProcessing: false, 
                    hedgeOpened: false
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi vào lệnh: ${e.msg || e.message}`, "error");
        if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally {
        openingSymbols.delete(symbol);
    }
}

// --- MONITOR & LOOPS ---

async function trackClosedPnL(symbol, closedTime, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const relevantTrades = trades.filter(t => Math.abs(t.time - closedTime) < 40000 && t.positionSide === lastBotPos.side);
        const rawPnL = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const fee = (lastBotPos.qty * lastBotPos.entryPrice) * 0.0008; // Phí ước tính
        status.botClosedCount++; 
        status.botPnLClosed += (rawPnL - fee);
        addBotLog(`✅ CHỐT ${symbol} | PnL: ${(rawPnL - fee).toFixed(2)}$`, "success");
    } catch (e) {}
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = now + (10 * 60 * 1000); // 10p blacklist
                trackClosedPnL(botPos.symbol, now, botPos); 
                botActivePositions.delete(key);
                // Dọn dẹp lệnh thừa sau khi đóng vị thế
                binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol: botPos.symbol }).catch(()=>{});
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
                botPos.priceDev = botPos.entryPrice ? ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100 : 0;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeShorts = posRisk.filter(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; 
            const realPos = activeShorts.find(p => p.symbol === botPos.symbol);
            if (!realPos) continue;

            const pEntry = parseFloat(realPos.entryPrice);
            const pMark = parseFloat(realPos.markPrice);
            const priceDev = ((pMark - pEntry) / pEntry) * 100;

            if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                await openPosition(botPos.symbol, true); 
            }
        }

        if (activeShorts.length < botSettings.maxPositions && openingSymbols.size === 0) {
            const candidate = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = Math.abs(parseFloat(c.c1)) >= parseFloat(botSettings.minVol);
                const isNotBlacklisted = (status.blackList[c.symbol] || 0) < Date.now();
                const isNotOpened = !activeShorts.some(p => p.symbol === c.symbol);
                return info && isNotBlacklisted && isNotOpened && hasVol;
            });
            if (candidate) await openPosition(candidate.symbol, false);
        }
    } catch (e) {}
}

// --- INITIALIZATION ---
async function init() {
    try {
        await syncTime(); 
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo; 
        status.isReady = true;
        addBotLog("👹 LUFFY AMEND-PROTOCOL READY", "success"); 
        priceMonitorLoop();
    } catch (e) { 
        setTimeout(init, 5000); 
    }
}

init(); 
setInterval(mainLoop, 3000);

// Cổng kết nối Dashboard & Dữ liệu
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
        const bl = {}; Object.entries(status.blackList).forEach(([s, t]) => { if(t > Date.now()) bl[s] = Math.ceil((t-Date.now())/1000); });
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status, blackList: bl }, wallet: { totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), availableBalance: parseFloat(acc.availableBalance).toFixed(2) } });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
