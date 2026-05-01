import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. CẤU HÌNH CCXT HOÀN CHỈNH
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, // Hedge Mode
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
 * 2. HÀM DỌN DẸP LỆNH (TRIỆT TIÊU LỖI -4130)
 */
async function clearAndVerify(symbol, side) {
    try {
        addBotLog(`🧹 [${symbol}] Đang dọn dẹp lệnh chờ...`);
        for (let i = 1; i <= 3; i++) {
            // Xóa tất cả lệnh chờ của symbol này qua CCXT
            await exchange.cancelAllOrders(symbol);
            await new Promise(r => setTimeout(r, 2000)); 

            const openOrders = await exchange.fetchOpenOrders(symbol);
            // Lọc đúng các lệnh đóng vị thế đang bị kẹt
            const ghostOrders = openOrders.filter(o => 
                o.info.positionSide === side && 
                (o.info.closePosition === 'true' || o.info.reduceOnly === 'true')
            );

            if (ghostOrders.length === 0) {
                addBotLog(`✅ [${symbol}] Sàn sạch lệnh.`);
                return true; 
            }

            for (const order of ghostOrders) {
                await exchange.cancelOrder(order.id, symbol);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi dọn dẹp: ${e.message}`, "error");
        return false;
    }
}

/**
 * 3. ĐẶT TP/SL CHUẨN PRECISION
 */
async function syncTPSL(symbol, side, entry) {
    const isShort = (side === 'SHORT');
    const tpPrice = isShort ? (entry * (1 - botSettings.posTP / 100)) : (entry * (1 + botSettings.posTP / 100));
    const slPrice = isShort ? (entry * (1 + botSettings.posSL / 100)) : (entry * (1 - botSettings.posSL / 100));
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        // Dùng hàm của CCXT để format giá đúng quy định sàn
        const finalTP = exchange.priceToPrecision(symbol, tpPrice);
        const finalSL = exchange.priceToPrecision(symbol, slPrice);

        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: finalTP, closePosition: true, workingType: 'MARK_PRICE'
        });
        
        await new Promise(r => setTimeout(r, 500));

        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, stopPrice: finalSL, closePosition: true, workingType: 'MARK_PRICE'
        });

        addBotLog(`✨ [${symbol}] TP: ${finalTP} | SL: ${finalSL}`, "success");
        return { tp: finalTP, sl: finalSL };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi TP/SL: ${e.message}`, "error");
        throw e;
    }
}

/**
 * 4. MỞ VỊ THẾ / DCA
 */
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        let currentPos = botActivePositions.get(posKey);
        
        if (isDCA && currentPos) {
            currentPos.isProcessing = true;
            const isClean = await clearAndVerify(symbol, 'SHORT');
            if (!isClean) return; // Không dọn được thì dừng để bảo vệ vốn
        }

        const ticker = await exchange.fetchTicker(symbol);
        const balance = await exchange.fetchBalance();
        const available = balance.free.USDT;

        let marginToUse = botSettings.invValue.toString().includes('%') 
            ? (available * parseFloat(botSettings.invValue) / 100) 
            : parseFloat(botSettings.invValue);

        const leverage = 20; // Có thể lấy động từ exchangeInfo nếu muốn
        let qty = (marginToUse * leverage) / ticker.last;
        const finalQty = exchange.amountToPrecision(symbol, qty);

        await exchange.setLeverage(leverage, symbol);
        
        const order = await exchange.createOrder(symbol, 'market', 'sell', finalQty, undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`🚀 [${symbol}] Khớp ${isDCA ? 'DCA' : 'OPEN'}. Đang sync...`);
            await new Promise(r => setTimeout(r, 3500)); 

            const positions = await exchange.fetchPositions([symbol]);
            const upPos = positions.find(p => p.symbol === symbol && p.side === 'short');
            
            if (upPos && upPos.contracts > 0) {
                const sync = await syncTPSL(symbol, 'SHORT', upPos.entryPrice);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: upPos.entryPrice, qty: upPos.contracts, 
                    tp: sync.tp, sl: sync.sl, dcaCount: isDCA ? (currentPos.dcaCount + 1) : 0, 
                    isProcessing: false, firstMargin: isDCA ? currentPos.firstMargin : marginToUse
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi hệ thống: ${e.message}`, "error");
    } finally {
        openingSymbols.delete(symbol);
    }
}

/**
 * 5. LOOP THEO DÕI GIÁ & ĐÓNG LỆNH
 */
async function priceMonitorLoop() {
    if (!status.isReady) return setTimeout(priceMonitorLoop, 1000);
    try {
        const positions = await exchange.fetchPositions();
        const now = Date.now();
        
        for (let [key, botPos] of botActivePositions) {
            const realPos = positions.find(p => p.symbol === botPos.symbol && p.side === 'short');
            
            if (!realPos || realPos.contracts === 0) {
                status.blackList[botPos.symbol] = now + (15 * 60 * 1000);
                // Track PnL đơn giản từ realPos nếu có hỗ trợ
                const pnl = realPos ? realPos.info.realizedPnl : 0;
                status.botClosedCount++;
                status.botPnLClosed += parseFloat(pnl || 0);
                addBotLog(`✅ CHỐT ${botPos.symbol}`, "success");
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = realPos.markPrice; 
                botPos.pnl = realPos.unrealizedPnl;
                botPos.priceDev = ((realPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 2000);
}

/**
 * 6. VÒNG LẶP CHÍNH (QUÉT KÈO & DCA)
 */
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const positions = await exchange.fetchPositions();
        const activeShorts = positions.filter(p => p.side === 'short' && p.contracts > 0);

        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; 
            if (botPos.priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                await openPosition(botPos.symbol, true); 
            }
        }

        if (activeShorts.length < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = exchange.market(c.symbol);
                const hasVol = [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
                return info && (status.blackList[c.symbol] || 0) < Date.now() && !activeShorts.some(p => p.symbol === c.symbol) && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

/**
 * 7. KHỞI TẠO & EXPRESS
 */
async function init() {
    try {
        await exchange.loadMarkets();
        status.isReady = true;
        addBotLog("👿 LUFFY CCXT ENGINE READY", "success"); 
        priceMonitorLoop();
    } catch (e) { 
        addBotLog("❌ Lỗi khởi tạo: " + e.message);
        setTimeout(init, 5000); 
    }
}

init(); 
setInterval(mainLoop, 3000);

// Fetch Candidates từ Bot Data
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
                totalWalletBalance: balance.total.USDT.toFixed(2), 
                availableBalance: balance.free.USDT.toFixed(2) 
            } 
        });
    } catch (e) { res.json({ status }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
