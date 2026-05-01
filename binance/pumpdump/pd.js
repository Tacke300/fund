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
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set(); 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() { try { const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); timestampOffset = res.data.serverTime - Date.now(); } catch (e) {} }

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

/**
 * FIX CHUẨN: XÓA TỪNG ORDER ID ĐỂ DIỆT TẬN GỐC TP/SL HEDGE MODE
 */
async function clearAllOrders(symbol) {
    try {
        let attempt = 0;
        while (attempt < 5) {
            attempt++;
            // Lấy danh sách lệnh thực tế đang treo (Gồm cả Limit, TP, SL, Trailing...)
            const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });

            if (orders.length === 0) {
                addBotLog(`🧹 [${symbol}] Sạch hoàn toàn lệnh chờ.`);
                return true;
            }

            // Debug xem lệnh gì còn sót
            const types = orders.map(o => `${o.type}(${o.positionSide})`).join(', ');
            addBotLog(`⚠️ [${symbol}] Còn sót: ${types}. Đang dọn lần ${attempt}...`, "warning");

            // Xóa từng orderId một để ép sàn thực thi 100%
            for (const o of orders) {
                try {
                    await binancePrivate('/fapi/v1/order', 'DELETE', { 
                        symbol, 
                        orderId: o.orderId 
                    });
                } catch (e) {
                    // Nếu lệnh đã khớp hoặc bị xóa trước đó thì bỏ qua lỗi này
                }
            }

            // Nghỉ 2 giây chờ sàn cập nhật trạng thái
            await new Promise(r => setTimeout(r, 2000));
        }
        addBotLog(`❌ [${symbol}] Dọn KHÔNG sạch sau 5 lần thử!`, "error");
        return false;
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi clear: ${e.message}`, "error");
        return false;
    }
}

async function syncTPSL(symbol, side, qty, entry, info) {
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        // Chỉ đặt lệnh mới khi dọn sạch 100% lệnh cũ
        const cleaned = await clearAllOrders(symbol);
        
        if (!cleaned) {
            addBotLog(`❌ [${symbol}] Dọn dẹp thất bại, hủy bỏ Sync TP/SL để an toàn.`, "error");
            return { tp: 0, sl: 0 };
        }

        addBotLog(`✨ [${symbol}] Đặt mới TP:${tpPrice} SL:${slPrice} (Qty:${qty})`);
        const params = { positionSide: side, workingType: 'MARK_PRICE' };

        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, qty, undefined, { ...params, stopPrice: tpPrice });
        await new Promise(r => setTimeout(r, 800)); 
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, qty, undefined, { ...params, stopPrice: slPrice });

        addBotLog(`✅ [${symbol}] Sync hoàn tất.`, "success");
        return { tp: Number(tpPrice), sl: Number(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi Sync: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

async function trackClosedPnL(symbol, closedTime, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 15 });
        const relevantTrades = trades.filter(t => Math.abs(t.time - closedTime) < 60000 && t.positionSide === lastBotPos.side);
        const rawPnL = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const totalVolume = lastBotPos.qty * lastBotPos.entryPrice;
        const fee = totalVolume * 0.001; 
        const finalPnL = rawPnL - fee;
        status.botClosedCount++; 
        status.botPnLClosed += finalPnL;
        addBotLog(`💰 CHỐT ${symbol} | PnL Net: ${finalPnL.toFixed(2)}$`, "success");
    } catch (e) {}
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(priceRes.data.price);
        
        let marginToUse = 0, currentDCA = 0, historyEntries = [], firstMargin = 0;
        if (isDCA) {
            const current = botActivePositions.get(posKey);
            firstMargin = current.firstMargin;
            marginToUse = firstMargin * 1.03; 
            current.isProcessing = true; currentDCA = current.dcaCount + 1;
            historyEntries = [...(current.historyEntries || [])];
        } else {
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / price) / info.stepSize) * info.stepSize;
        while ((qtyNum * price) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            await new Promise(r => setTimeout(r, 2000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            const avgEntry = parseFloat(upPos.entryPrice);
            const totalQty = Math.abs(parseFloat(upPos.positionAmt));
            historyEntries.push(price);

            if (isDCA) addBotLog(`⚠️ DCA ${symbol} : Lần ${currentDCA} | Avg:${avgEntry}`, "warning");
            else addBotLog(`✅ OPEN ${symbol} | Entry: ${price}`, "success");

            const sync = await syncTPSL(symbol, 'SHORT', totalQty, avgEntry, info);
            botActivePositions.set(posKey, { 
                symbol, side: 'SHORT', entryPrice: avgEntry, historyEntries, qty: totalQty, tp: sync.tp, sl: sync.sl, 
                margin: (totalQty * avgEntry / info.maxLeverage), firstMargin, dcaCount: currentDCA, isProcessing: false, hedgeOpened: false
            });
        }
    } catch (e) { 
        if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false; 
    }
    finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // FIX RACE CONDITION: Position đóng -> Phải xóa lệnh -> Thành công mới xóa khỏi Map
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) <= 0) {
                addBotLog(`✅ [${botPos.symbol}] Đã đóng vị thế.`);
                
                const cleaned = await clearAllOrders(botPos.symbol);
                if (!cleaned) {
                    addBotLog(`❌ [${botPos.symbol}] Vị thế đã đóng nhưng lệnh chờ vẫn treo!`, "error");
                }

                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                trackClosedPnL(botPos.symbol, now, botPos); 
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
                botPos.priceDev = botPos.entryPrice ? (((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100) : 0;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeRealPos = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing || botPos.side !== 'SHORT') continue;
            const realPos = activeRealPos.find(p => p.symbol === botPos.symbol && p.positionSide === 'SHORT');
            if (realPos && ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice) * 100) >= botSettings.dcaStep) {
                if (botPos.dcaCount < botSettings.maxDCA) await openPosition(botPos.symbol, true);
            }
        }
        if (activeRealPos.filter(p => p.positionSide === 'SHORT').length < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                return info && info.maxLeverage >= 20 && (status.blackList[c.symbol] || 0) < Date.now() && !activeRealPos.some(p => p.symbol === c.symbol && p.positionSide === 'SHORT') && [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        await syncTime(); await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 };
        });
        status.exchangeInfo = tempInfo; status.isReady = true;
        addBotLog("👿 LUFFY READY - PRO DRAIN SYSTEM", "success"); priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init(); setInterval(mainLoop, 3000);
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
        res.json({ 
            botSettings, activePositions: Array.from(botActivePositions.values()), status,
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) 
            } 
        });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
