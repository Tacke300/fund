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

// Cấu hình axios cho Binance Raw API
const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

// Cấu hình CCXT (Dùng cho Market Order và load thị trường)
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        adjustForTimeDifference: true, 
        recvWindow: 60000 
    } 
});

// Biến môi trường và trạng thái
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1%", 
    minVol: 6.5, 
    posTP: 0.5, 
    posSL: 50.0, 
    dcaStep: 10.0, 
    maxDCA: 4 
};

let status = { 
    botLogs: [], 
    exchangeInfo: null, 
    candidatesList: [], 
    isReady: false, 
    blackList: {}, 
    botClosedCount: 0, 
    botPnLClosed: 0 
};

let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set(); 

// Hàm Log hệ thống
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Đồng bộ thời gian server
async function syncTime() { 
    try { 
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); 
        timestampOffset = res.data.serverTime - Date.now(); 
    } catch (e) {
        addBotLog("Lỗi đồng bộ thời gian: " + e.message, "error");
    } 
}

// Hàm gọi API Binance gốc (Raw)
async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ 
            method, 
            url: `${endpoint}?${query}&signature=${signature}` 
        });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

/**
 * PROTOCOL: ĐỢI VỊ THẾ ỔN ĐỊNH
 * Đảm bảo Binance đã cập nhật xong số lượng coin trước khi đặt TP/SL
 */
async function waitPositionStable(symbol, side) {
    let lastSize = 0, stableCount = 0;
    for (let i = 0; i < 15; i++) {
        try {
            const pos = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pos.find(x => x.positionSide === side);
            const size = p ? Math.abs(parseFloat(p.positionAmt)) : 0;
            if (size > 0 && size === lastSize) stableCount++;
            else stableCount = 0;
            if (stableCount >= 2) return size;
            lastSize = size;
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) { 
            await new Promise(r => setTimeout(r, 1000)); 
        }
    }
    return lastSize;
}

/**
 * PROTOCOL: ĐỒNG BỘ TP/SL QUA RAW API
 * Fix triệt để lỗi -1106 và -4130 bằng cách bỏ qua CCXT
 */
async function syncTPSL(symbol, side, entry, info, actualQty) {
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    
    // Ép quantity chuẩn stepSize tuyệt đối
    const qtyStr = parseFloat(actualQty).toFixed(info.quantityPrecision);

    for (let i = 0; i < 3; i++) {
        try {
            // 1. Xóa toàn bộ lệnh chờ cũ của symbol này
            await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
            await new Promise(r => setTimeout(r, 2000));

            // 2. Đặt lệnh TAKE_PROFIT_LIMIT (hoặc LIMIT với reduceOnly)
            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol,
                side: sideClose,
                type: 'LIMIT',
                quantity: qtyStr,
                price: tpPrice,
                timeInForce: 'GTC',
                reduceOnly: 'true',
                positionSide: side
            });
            
            await new Promise(r => setTimeout(r, 1000));

            // 3. Đặt lệnh STOP_MARKET (Dùng closePosition để đảm bảo đóng sạch ví)
            await binancePrivate('/fapi/v1/order', 'POST', {
                symbol,
                side: sideClose,
                type: 'STOP_MARKET',
                stopPrice: slPrice,
                closePosition: 'true',
                positionSide: side,
                workingType: 'MARK_PRICE'
            });

            addBotLog(`✨ [${symbol}] Đã đồng bộ TP: ${tpPrice}, SL: ${slPrice} (Qty: ${qtyStr})`, "success");
            return { tp: Number(tpPrice), sl: Number(slPrice) };
        } catch (e) {
            addBotLog(`⚠️ [${symbol}] Thử lại đặt TPSL lần ${i+1}: ${e.message}`, "warning");
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    throw new Error("KHÔNG THỂ ĐỒNG BỘ TPSL");
}

/**
 * HÀM MỞ VỊ THẾ (MARKET)
 */
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    
    openingSymbols.add(symbol); 
    try {
        const info = status.exchangeInfo[symbol];
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        
        let currentPos = botActivePositions.get(posKey);
        if (isDCA && currentPos) currentPos.isProcessing = true; 

        // Tính Margin
        let marginToUse = isDCA ? 
            currentPos.firstMargin * 1.03 : 
            (botSettings.invValue.toString().includes('%') ? 
                (parseFloat((await binancePrivate('/fapi/v2/account')).availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) : 
                parseFloat(botSettings.invValue));

        // Tính Quantity chuẩn
        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        while ((qtyNum * currentPrice) < 5.5) qtyNum += info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        
        // Mở lệnh Market (Vẫn dùng CCXT vì ít lỗi tham số ở lệnh Market)
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`🚀 [${symbol}] Mở lệnh thành công. Đang đợi vị thế ổn định...`);
            const stableQty = await waitPositionStable(symbol, 'SHORT');
            await new Promise(r => setTimeout(r, 2000)); 

            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            
            if (upPos && stableQty > 0) {
                const finalEntry = parseFloat(upPos.entryPrice);
                // Gọi Raw API Sync TPSL
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info, stableQty);
                
                botActivePositions.set(posKey, { 
                    symbol, 
                    side: 'SHORT', 
                    entryPrice: finalEntry, 
                    qty: stableQty, 
                    tp: sync.tp, 
                    sl: sync.sl, 
                    firstMargin: isDCA ? currentPos.firstMargin : marginToUse, 
                    dcaCount: isDCA ? currentPos.dcaCount + 1 : 0, 
                    isProcessing: false
                });
            }
        }
    } catch (e) {
        addBotLog(`🚨 [${symbol}] Lỗi mở vị thế: ${e.message}`, "error");
    } finally {
        openingSymbols.delete(symbol);
    }
}

/**
 * HÀM THEO DÕI PNL SAU KHI ĐÓNG LỆNH
 */
async function trackClosedPnL(symbol, closedTime, lastBotPos) {
    try {
        await new Promise(r => setTimeout(r, 8000)); // Đợi sàn chốt sổ
        const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol, limit: 20 });
        const relevantTrades = trades.filter(t => Math.abs(t.time - closedTime) < 60000 && t.positionSide === lastBotPos.side);
        
        const rawPnL = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
        const fee = (lastBotPos.qty * lastBotPos.entryPrice) * 0.0008; 
        
        status.botClosedCount++; 
        status.botPnLClosed += (rawPnL - fee);
        addBotLog(`✅ CHỐT LỆNH ${symbol} | Net PnL: ${(rawPnL - fee).toFixed(2)}$`, "success");
    } catch (e) {
        addBotLog(`Lỗi track PnL ${symbol}: ${e.message}`, "warning");
    }
}

/**
 * VÒNG LẶP MONITOR GIÁ & PNL TẠM TÍNH
 */
async function priceMonitorLoop() {
    if (!status.isReady) { setTimeout(priceMonitorLoop, 1000); return; }
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            // Nếu không còn vị thế trên sàn -> Đã chốt (TP/SL/Manual)
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = now + (10 * 60 * 1000); // Blacklist 10p
                trackClosedPnL(botPos.symbol, now, botPos);
                botActivePositions.delete(key);
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
                botPos.priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000);
}

/**
 * VÒNG LẶP QUÉT TÍN HIỆU & DCA
 */
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeShorts = posRisk.filter(p => p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        // Check DCA
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue;
            const realPos = activeShorts.find(p => p.symbol === botPos.symbol);
            if (!realPos) continue;

            const priceDev = ((parseFloat(realPos.markPrice) - parseFloat(realPos.entryPrice)) / parseFloat(realPos.entryPrice)) * 100;
            if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                addBotLog(`🔄 [${botPos.symbol}] Chạm điểm DCA lần ${botPos.dcaCount + 1}`);
                await openPosition(botPos.symbol, true); 
            }
        }

        // Check Mở lệnh mới
        if (activeShorts.length < botSettings.maxPositions && openingSymbols.size === 0) {
            const candidate = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = Math.abs(parseFloat(c.c1)) >= botSettings.minVol || Math.abs(parseFloat(c.c5)) >= botSettings.minVol;
                return info && info.maxLeverage >= 20 && (status.blackList[c.symbol] || 0) < Date.now() && !activeShorts.some(p => p.symbol === c.symbol) && hasVol;
            });
            if (candidate) await openPosition(candidate.symbol, false);
        }
    } catch (e) {}
}

/**
 * KHỞI TẠO HỆ THỐNG
 */
async function init() {
    try {
        addBotLog("🔄 Đang khởi tạo hệ thống...");
        await syncTime(); 
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
        addBotLog("👿 LUFFY RAW-API ENGINE ONLINE", "success"); 
        priceMonitorLoop();
    } catch (e) { 
        addBotLog("Init lỗi: " + e.message, "error");
        setTimeout(init, 5000); 
    }
}

init(); 
setInterval(mainLoop, 3000);

/**
 * SERVER API & UI DASHBOARD
 */
const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        
        // CÁC CHỈ SỐ VÍ CHUẨN APP BINANCE
        const totalEquity = parseFloat(acc.totalMarginBalance).toFixed(2); // Số dư tổng (Ví + PnL)
        const walletBalance = parseFloat(acc.totalWalletBalance).toFixed(2); // Tiền gốc
        const unrealizedPnL = parseFloat(acc.totalUnrealizedProfit).toFixed(2); // PnL tạm tính
        const available = parseFloat(acc.availableBalance).toFixed(2); // Tiền có thể dùng

        const bl = {}; 
        Object.entries(status.blackList).forEach(([s, t]) => { 
            if(t > Date.now()) bl[s] = Math.ceil((t-Date.now())/1000); 
        });

        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()), 
            status: { ...status, blackList: bl }, 
            wallet: { 
                totalWalletBalance: walletBalance,
                totalUnrealizedProfit: unrealizedPnL,
                equity: totalEquity, 
                availableBalance: available
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

APP.listen(9001, () => console.log("Dashboard: http://localhost:9001"));

// Đồng bộ dữ liệu từ Scanner (Bot tín hiệu)
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { 
            try { 
                status.candidatesList = JSON.parse(d).live || []; 
            } catch (e) {} 
        });
    }).on('error', () => {});
}, 2000);
