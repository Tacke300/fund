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

// ============ LOCK SYSTEM ============
const positionLocks = new Map();
const dcaCleanupLocks = new Map();
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const BLACKLIST_DURATION = 15 * 60 * 1000;

// ============ UTILITY: RETRY WITH EXPONENTIAL BACKOFF ============
async function retryWithBackoff(fn, functionName = 'API Call', maxRetries = MAX_RETRIES) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) {
                addBotLog(`❌ ${functionName} failed after ${maxRetries} retries: ${error.message}`, "error");
                throw error;
            }
            const delay = Math.pow(2, i) * RETRY_BASE_DELAY;
            addBotLog(`⏳ ${functionName} retry ${i + 1}/${maxRetries} sau ${delay}ms: ${error.message}`, "warning");
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ============ UTILITY: POSITION LOCK ============
async function acquirePositionLock(symbol) {
    const posKey = `${symbol}_SHORT`;
    const timeout = 120000;
    const startTime = Date.now();
    
    while (positionLocks.has(posKey)) {
        if (Date.now() - startTime > timeout) {
            addBotLog(`❌ [${symbol}] Lock timeout, force unlock`, "error");
            positionLocks.delete(posKey);
            break;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    
    positionLocks.set(posKey, true);
}

function releasePositionLock(symbol) {
    const posKey = `${symbol}_SHORT`;
    positionLocks.delete(posKey);
}

// ============ UTILITY: DCA CLEANUP LOCK ============
async function acquireDCACleanupLock(symbol) {
    const dcaKey = `DCA_CLEANUP_${symbol}_SHORT`;
    const timeout = 60000;
    const startTime = Date.now();
    
    while (dcaCleanupLocks.has(dcaKey)) {
        if (Date.now() - startTime > timeout) {
            addBotLog(`❌ [${symbol}] DCA cleanup lock timeout, force unlock`, "error");
            dcaCleanupLocks.delete(dcaKey);
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    
    dcaCleanupLocks.set(dcaKey, true);
}

function releaseDCACleanupLock(symbol) {
    const dcaKey = `DCA_CLEANUP_${symbol}_SHORT`;
    dcaCleanupLocks.delete(dcaKey);
}

// ============ LOGGING ============
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// ============ BINANCE PRIVATE API CALL ============
async function binancePrivate(endpoint, method = 'GET', data = {}) {
    return retryWithBackoff(async () => {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        try {
            const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
            return response.data;
        } catch (error) { 
            throw new Error(error.response?.data?.msg || error.message); 
        }
    }, `binancePrivate(${endpoint})`);
}

// ============ WAIT UNTIL ALL ORDERS CLEARED ============
async function waitUntilAllOrdersCleared(symbol, maxWaitTime = 15000) {
    const startTime = Date.now();
    let lastOrderCount = -1;
    
    while (Date.now() - startTime < maxWaitTime) {
        try {
            const openOrders = await exchange.fetchOpenOrders(symbol);
            const openOrdersCount = openOrders.length;
            
            if (openOrdersCount === 0) {
                addBotLog(`✅ [${symbol}] Tất cả lệnh chờ đã được dọn sạch`);
                return true;
            }
            
            if (openOrdersCount !== lastOrderCount) {
                addBotLog(`⏳ [${symbol}] Còn ${openOrdersCount} lệnh chờ, đang đợi...`);
                lastOrderCount = openOrdersCount;
            }
            
            await new Promise(r => setTimeout(r, 800));
        } catch (e) {
            addBotLog(`⚠️ [${symbol}] Lỗi check order: ${e.message}`, "warning");
            await new Promise(r => setTimeout(r, 500));
        }
    }
    
    addBotLog(`⚠️ [${symbol}] Timeout chờ dọn lệnh (${maxWaitTime}ms), tiếp tục với lệnh còn lại`, "warning");
    return false;
}

// ============ 1. DỌN LỆNH CHỜ ============
async function forceClearAllOrders(symbol) {
    try {
        addBotLog(`🧹 [${symbol}] Đang dọn dẹp lệnh chờ...`);
        
        const openOrders = await exchange.fetchOpenOrders(symbol);
        for (const order of openOrders) {
            try {
                // Trong chế độ 2 chiều, nên truyền positionSide để dọn sạch tuyệt đối
                await exchange.cancelOrder(order['id'], symbol, { positionSide: order['info']?.positionSide || 'SHORT' });
            } catch (e) {
                addBotLog(`⚠️ [${symbol}] Không thể xóa order ${order['id']}: ${e.message}`, "warning");
            }
        }
        
        let retry = 0;
        while (retry < 3) {
            await new Promise(r => setTimeout(r, 500));
            const remainingOrders = await exchange.fetchOpenOrders(symbol);
            if (remainingOrders.length === 0) {
                addBotLog(`✨ [${symbol}] Đã dọn sạch lệnh chờ.`);
                return true;
            }
            retry++;
        }
        return true;
    } catch (e) { 
        addBotLog(`❌ [${symbol}] Lỗi dọn lệnh: ${e.message}`, "error");
        return false;
    }
}

// ============ 2. VERIFY TPSL ORDERS EXIST (FIXED FOR DUAL SIDE) ============
async function verifyTPSLOrders(symbol, side, maxAttempts = 5) {
    let attempts = 0;
    while (attempts < maxAttempts) {
        try {
            await new Promise(r => setTimeout(r, 2000)); // Delay để sàn cập nhật
            const openOrders = await exchange.fetchOpenOrders(symbol);
            
            // Lọc chính xác theo type và positionSide trong info
            const tpslOrders = openOrders.filter(o => {
                const type = o.info.type || o.type;
                const posSide = o.info.positionSide;
                return ['TAKE_PROFIT_MARKET', 'STOP_MARKET'].includes(type) && posSide === side;
            });
            
            const hasTP = tpslOrders.some(o => (o.info.type || o.type) === 'TAKE_PROFIT_MARKET');
            const hasSL = tpslOrders.some(o => (o.info.type || o.type) === 'STOP_MARKET');

            if (hasTP && hasSL) {
                addBotLog(`✅ [${symbol}] Xác nhận đầy đủ TP và SL cho ${side}`);
                return true;
            }
            
            addBotLog(`⏳ [${symbol}] Lệnh chờ chưa đủ (${tpslOrders.length}/2), thử lại ${attempts + 1}/${maxAttempts}...`);
            attempts++;
        } catch (e) { 
            addBotLog(`⚠️ [${symbol}] Lỗi verify TPSL: ${e.message}`, "warning");
            attempts++;
        }
    }
    addBotLog(`❌ [${symbol}] Không thể xác nhận lệnh chờ sau ${maxAttempts} lần thử`, "error");
    return false;
}

// ============ 3. ĐẶT TP/SL MỚI & ĐÓNG VỊ THẾ NẾU LỖI ============
async function syncTPSL(symbol, side, entry, info, isDCA = false) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';

    if (isDCA) await acquireDCACleanupLock(symbol);

    try {
        addBotLog(`🧹 [${symbol}] ${isDCA ? '[DCA]' : ''} Bước 1: Dọn sạch lệnh chờ cũ...`);
        await forceClearAllOrders(symbol);
        
        addBotLog(`⏳ [${symbol}] ${isDCA ? '[DCA]' : ''} Bước 2: Chờ sàn cập nhật...`);
        await waitUntilAllOrdersCleared(symbol, 20000);
        await new Promise(r => setTimeout(r, 2000));

        addBotLog(`📍 [${symbol}] Đặt TP @ ${tpPrice} và SL @ ${slPrice}`);
        
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        
        await new Promise(r => setTimeout(r, 500));

        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, {
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });

        // XÁC NHẬN LỆNH CHỜ
        const verified = await verifyTPSLOrders(symbol, side, 5);
        
        if (!verified) {
            addBotLog(`🚨 [${symbol}] KHÔNG THỂ CÀI TP/SL! ĐANG ĐÓNG VỊ THẾ ĐỂ BẢO VỆ TÀI KHOẢN...`, "error");
            
            // Lấy khối lượng thực tế để đóng sạch
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realPos) {
                const qty = Math.abs(parseFloat(realPos.positionAmt));
                await exchange.createOrder(symbol, 'MARKET', sideClose, qty.toFixed(info.quantityPrecision), undefined, { 
                    positionSide: side 
                });
                addBotLog(`🔥 [${symbol}] Đã thực hiện đóng Market vị thế ${side} thành công.`);
            }
            return { success: false };
        }

        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice), success: true };
    } catch (e) {
        addBotLog(`❌ [${symbol}] LỖI KHI SYNC TP/SL: ${e.message}`, "error");
        return { success: false };
    } finally {
        if (isDCA) releaseDCACleanupLock(symbol);
    }
}

// ============ 4. MỞ VỊ THẾ & DCA ============
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    
    try {
        await acquirePositionLock(symbol);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const hasPosOnExchange = posRisk.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!isDCA && hasPosOnExchange) {
            addBotLog(`⚠️ [${symbol}] Đã có vị thế SHORT trên sàn, thêm vào blacklist 15p`, "warning");
            status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
            return;
        }

        let cp = null;
        if (isDCA) {
            cp = botActivePositions.get(posKey);
            if (!cp) {
                addBotLog(`⚠️ [${symbol}] Không tìm thấy vị thế gốc cho DCA`, "warning");
                return;
            }
            if (cp.isProcessing) {
                addBotLog(`⚠️ [${symbol}] Vị thế đang xử lý DCA, bỏ qua`, "warning");
                return;
            }
            cp.isProcessing = true;
        } else {
            if (botActivePositions.has(posKey)) {
                addBotLog(`⚠️ [${symbol}] Đã có vị thế trong botActivePositions, thêm vào blacklist 15p`, "warning");
                status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
                return;
            }
            if (openingSymbols.has(symbol)) {
                addBotLog(`⚠️ [${symbol}] Đang mở vị thế, bỏ qua`, "warning");
                return;
            }
            openingSymbols.add(symbol);
        }

        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0, currentDCA = 0, firstMargin = 0, originalEntry = 0;
        
        if (isDCA) {
            firstMargin = cp.firstMargin;
            originalEntry = cp.originalEntry || cp.entryPrice;
            currentDCA = cp.dcaCount + 1;
            marginToUse = firstMargin * 1.0;
            addBotLog(`💎 [${symbol}] [DCA #${currentDCA}] Margin: ${marginToUse.toFixed(2)}$ | Price: ${currentPrice}`, "info");
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
            originalEntry = currentPrice;
            addBotLog(`💎 [${symbol}] [OPEN] Margin: ${marginToUse.toFixed(2)}$ | Price: ${currentPrice}`, "info");
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        
        const order = await retryWithBackoff(async () => {
            return exchange.createOrder(symbol, 'MARKET', 'SELL', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });
        }, `openPosition(${symbol})`);

        if (order) {
            const waitTime = isDCA ? 5000 : 3000;
            addBotLog(`⏳ [${symbol}] Đang đợi ${waitTime/1000}s sàn cập nhật...`);
            await new Promise(r => setTimeout(r, waitTime)); 
            
            const posDataUpdate = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const realPos = posDataUpdate.find(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realPos) {
                const finalEntry = parseFloat(realPos.entryPrice);
                const finalQty = Math.abs(parseFloat(realPos.positionAmt));
                
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, isDCA);
                
                if (sync.success) {
                    addBotLog(`✅ [${symbol}] THÀNH CÔNG | Entry: ${finalEntry} | TP: ${sync.tp} | SL: ${sync.sl}`);
                    botActivePositions.set(posKey, { 
                        symbol, side: 'SHORT', entryPrice: finalEntry, originalEntry, qty: finalQty, 
                        tp: sync.tp || 0, sl: sync.sl || 0, firstMargin, dcaCount: currentDCA, 
                        leverage: info.maxLeverage, isProcessing: false, pnl: 0, priceDev: 0
                    });
                    status.blackList[symbol] = Date.now() + BLACKLIST_DURATION;
                }
            } else {
                addBotLog(`❌ [${symbol}] Không tìm thấy vị thế sau khi khớp lệnh`, "error");
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] LỖI OPEN: ${e.message}`, "error");
        if(isDCA && botActivePositions.has(posKey)) {
            botActivePositions.get(posKey).isProcessing = false;
        }
    } finally { 
        openingSymbols.delete(symbol);
        releasePositionLock(symbol);
    }
}

// ============ PRICE MONITOR LOOP ============
async function priceMonitorLoop() {
    if (!status.isReady) { 
        setTimeout(priceMonitorLoop, 1000); 
        return; 
    }
    
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const closedPositions = [];

        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                closedPositions.push({ key, symbol: botPos.symbol, pos: botPos });
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }

        for (const closed of closedPositions) {
            trackClosedPnL(closed.symbol, closed.pos).then(() => {
                botActivePositions.delete(closed.key);
            }).catch(e => {
                addBotLog(`❌ Lỗi khi track PnL ${closed.symbol}: ${e.message}`, "error");
            });
        }
    } catch (e) {
        addBotLog(`❌ Monitor error: ${e.message}`, "error");
    }
    
    setTimeout(priceMonitorLoop, 1000);
}

// ============ TRACK CLOSED PNL ============
async function trackClosedPnL(symbol, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 6000));
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
        const finalPnL = trades.filter(t => (Date.now() - t.time) < 60000).reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        status.botClosedCount++; 
        status.botPnLClosed += finalPnL;
        addBotLog(`✅ CHỐT ${symbol} | PnL: ${finalPnL.toFixed(2)}$`, "success");
    } catch (e) {
        addBotLog(`⚠️ Lỗi track PnL ${symbol}: ${e.message}`, "warning");
    }
}

// ============ MAIN LOOP ============
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    
    try {
        const now = Date.now();
        let removedCount = 0;
        Object.keys(status.blackList).forEach(s => { 
            if(status.blackList[s] < now) {
                delete status.blackList[s];
                removedCount++;
            }
        });

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            if (botPos.dcaCount < botSettings.maxDCA && botPos.priceDev >= botSettings.dcaStep) {
                await openPosition(botPos.symbol, true);
            }
        }

        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = Math.abs(parseFloat(c.c1)) >= parseFloat(botSettings.minVol) || Math.abs(parseFloat(c.c5)) >= parseFloat(botSettings.minVol);
                return info && info.maxLeverage >= 20 && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`) && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {
        addBotLog(`❌ Main loop error: ${e.message}`, "error");
    }
}

// ============ INITIALIZATION ============
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
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY V20.7 - FULL DUAL SIDE READY", "success");
        priceMonitorLoop();
    } catch (e) { 
        addBotLog(`❌ Init error: ${e.message}`, "error");
        setTimeout(init, 5000); 
    }
}

// ============ ERROR HANDLERS ============
process.on('unhandledRejection', (reason, promise) => {
    addBotLog(`❌ Unhandled Rejection: ${reason}`, "error");
});
process.on('uncaughtException', (error) => {
    addBotLog(`❌ Uncaught Exception: ${error.message}`, "error");
});

// ============ START ============
init(); 
setInterval(mainLoop, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; 
        res.on('data', c => d += c);
        res.on('end', () => { 
            try { 
                status.candidatesList = JSON.parse(d).live || []; 
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

// ============ EXPRESS SERVER ============
const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) 
            },
            locks: {
                positionLocksCount: positionLocks.size,
                dcaCleanupLocksCount: dcaCleanupLocks.size,
                openingSymbolsCount: openingSymbols.size
            }
        });
    } catch (e) { 
        res.json({ status }); 
    }
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    res.json({ success: true }); 
});

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

APP.listen(9001);
