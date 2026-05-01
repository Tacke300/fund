import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// KHỞI TẠO CCXT
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, // Chế độ Hedge Mode
        adjustForTimeDifference: true, 
        recvWindow: 60000 
    } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0 };
let botActivePositions = new Map();
let openingSymbols = new Set(); 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

/**
 * 1. TRUY QUÉT LỆNH DÙNG CCXT
 */
async function clearAndVerify(symbol, side) {
    try {
        addBotLog(`🧹 [${symbol}] Đang dọn dẹp lệnh chờ bằng CCXT...`);
        
        for (let i = 1; i <= 3; i++) {
            // Xóa tất cả lệnh chờ của symbol này
            await exchange.cancelAllOrders(symbol);
            await new Promise(r => setTimeout(r, 2000)); // Nghỉ cho sàn đồng bộ

            // Lấy danh sách lệnh đang mở
            const openOrders = await exchange.fetchOpenOrders(symbol);
            
            // Lọc đúng các lệnh đóng vị thế (Close Position) đang bị kẹt
            const ghostOrders = openOrders.filter(o => 
                o.info.positionSide === side && 
                (o.info.closePosition === 'true' || o.info.reduceOnly === 'true')
            );

            if (ghostOrders.length === 0) {
                addBotLog(`✅ [${symbol}] Sàn sạch lệnh.`);
                return true; 
            }

            // Ép xóa từng lệnh theo ID nếu cancelAllOrders sót
            for (const order of ghostOrders) {
                await exchange.cancelOrder(order.id, symbol);
            }
            addBotLog(`⚠️ [${symbol}] Lần ${i}: Đã ép xóa ${ghostOrders.length} lệnh ma.`, "warning");
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi dọn dẹp: ${e.message}`, "error");
        return false;
    }
}

/**
 * 2. ĐẶT TP/SL DÙNG CCXT
 */
async function syncTPSL(symbol, side, entry, info) {
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        // Kiểm tra lệnh ma lần cuối qua CCXT
        const openOrders = await exchange.fetchOpenOrders(symbol);
        if (openOrders.some(o => o.info.positionSide === side && o.info.closePosition === 'true')) {
            throw new Error("Vẫn còn lệnh Close cũ chưa dọn sạch!");
        }

        // Đặt lệnh TP
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: tpPrice, closePosition: true, workingType: 'MARK_PRICE'
        });
        
        await new Promise(r => setTimeout(r, 500));

        // Đặt lệnh SL
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: slPrice, closePosition: true, workingType: 'MARK_PRICE'
        });

        addBotLog(`✨ [${symbol}] Đã cài TP:${tpPrice} SL:${slPrice}`, "success");
        return { tp: Number(tpPrice), sl: Number(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi đặt TP/SL: ${e.message}`, "error");
        throw e;
    }
}

/**
 * 3. MỞ VỊ THẾ / DCA
 */
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await exchange.fetchTicker(symbol);
        const currentPrice = ticker.last;
        
        let currentPos = botActivePositions.get(posKey);
        let marginToUse = 0, currentDCA = 0, firstMargin = 0;

        if (isDCA && currentPos) {
            currentPos.isProcessing = true;
            const isClean = await clearAndVerify(symbol, 'SHORT');
            if (!isClean) {
                addBotLog(`❌ [${symbol}] Không thể dọn sàn. Hủy DCA!`, "error");
                return; 
            }
            firstMargin = currentPos.firstMargin;
            marginToUse = firstMargin * 1.03; 
            currentDCA = currentPos.dcaCount + 1;
        } else {
            const balance = await exchange.fetchBalance();
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (balance.free.USDT * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
        }

        let qtyNum = (marginToUse * info.maxLeverage) / currentPrice;
        qtyNum = exchange.amountToPrecision(symbol, qtyNum);

        await exchange.setLeverage(info.maxLeverage, symbol);
        
        // Đặt lệnh Market Open
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum, undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`🚀 [${symbol}] Khớp ${isDCA ? 'DCA' : 'OPEN'}. Đang đồng bộ...`);
            await new Promise(r => setTimeout(r, 3000)); 

            const positions = await exchange.fetchPositions([symbol]);
            const upPos = positions.find(p => p.symbol === symbol && p.side === 'short');
            
            if (upPos && upPos.contracts > 0) {
                const finalEntry = upPos.entryPrice;
                const finalQty = upPos.contracts;

                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: finalQty, tp: sync.tp, sl: sync.sl, 
                    margin: (finalQty * finalEntry / info.maxLeverage), firstMargin, dcaCount: currentDCA, 
                    isProcessing: false,
                    hedgeOpened: false
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] LỖI: ${e.message}`, "error");
    } finally {
        openingSymbols.delete(symbol);
    }
}

/**
 * 4. THEO DÕI PNL (CCXT)
 */
async function trackClosedPnL(symbol, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
        const relevantTrades = trades.filter(t => t.info.positionSide === lastBotPos.side);
        
        // Lấy PnL từ trade cuối cùng
        const lastTrade = relevantTrades[relevantTrades.length - 1];
        const pnl = parseFloat(lastTrade.info.realizedPnl || 0);
        
        status.botClosedCount++; 
        status.botPnLClosed += pnl;
        addBotLog(`✅ CHỐT ${symbol} | PnL net: ${pnl.toFixed(2)}$`, "success");
    } catch (e) {
        addBotLog(`⚠️ Không lấy được PnL chốt cho ${symbol}`);
    }
}

async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const positions = await exchange.fetchPositions();
        const now = Date.now();
        
        for (let [key, botPos] of botActivePositions) {
            const realPos = positions.find(p => p.symbol === botPos.symbol && p.side === 'short');
            
            if (!realPos || realPos.contracts === 0) {
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                trackClosedPnL(botPos.symbol, botPos); 
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = realPos.markPrice; 
                botPos.pnl = realPos.unrealizedPnl;
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 2000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const positions = await exchange.fetchPositions();
        const activeShorts = positions.filter(p => p.side === 'short' && p.contracts > 0);

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; 
            const realPos = activeShorts.find(p => p.symbol === botPos.symbol);
            if (!realPos) continue;

            if (botPos.priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                await openPosition(botPos.symbol, true); 
            }
        }

        // Mở vị thế mới
        if (activeShorts.length < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
                return info && (status.blackList[c.symbol] || 0) < Date.now() && !activeShorts.some(p => p.symbol === c.symbol) && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    try {
        addBotLog("🔄 Đang khởi tạo hệ thống CCXT...");
        await exchange.loadMarkets();
        
        // Lấy thông tin đòn bẩy và bước giá
        const markets = exchange.markets;
        const tempInfo = {};
        for (const symbol in markets) {
            const m = markets[symbol];
            if (m.linear) {
                tempInfo[symbol] = {
                    quantityPrecision: m.precision.amount,
                    pricePrecision: m.precision.price,
                    stepSize: m.limits.amount.min,
                    maxLeverage: 20 // Mặc định hoặc fetch từ fetchLeverageBrackets nếu cần
                };
            }
        }
        
        status.exchangeInfo = tempInfo; 
        status.isReady = true;
        addBotLog("👿 LUFFY CCXT READY", "success"); 
        priceMonitorLoop();
    } catch (e) { 
        addBotLog("❌ Init lỗi: " + e.message);
        setTimeout(init, 5000); 
    }
}

init(); 
setInterval(mainLoop, 3000);

// Giữ nguyên phần Express và API CANDIDATES
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 2000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        const balance = await exchange.fetchBalance();
        const bl = {}; 
        Object.entries(status.blackList).forEach(([s, t]) => { if(t > Date.now()) bl[s] = Math.ceil((t-Date.now())/1000); });
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: bl },
            wallet: { 
                totalWalletBalance: balance.total.USDT, 
                availableBalance: balance.free.USDT 
            } 
        });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
