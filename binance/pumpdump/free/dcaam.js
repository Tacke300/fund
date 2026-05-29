import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// CẤU HÌNH NHANH - CÁC THÔNG SỐ CỐ ĐỊNH HỆ THỐNG
// =========================================================================
const MARGIN_PROTECT_LIMIT = 60;    // Dưới 60% Khả dụng/Ví -> Ngừng quét lệnh mới
const MARGIN_RECOVER_LIMIT = 70;    // Đạt lại từ 70% Khả dụng trở lên -> Tiếp tục quét lại
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        recvWindow: 60000, 
        adjustForTimeDifference: true 
    } 
});

// Khởi tạo mặc định
let botSettings = { 
    isRunning: false, 
    capital: "1%", 
    volVolatility: 6.5, 
    maxPos: 3, 
    maxDca: 2,
    tp: 1.2, 
    sl: 10.0,
    longTp: 1.5,
    longSl: 8.0 
};

// Đọc cấu hình từ file nếu có (Lưu trạng thái vĩnh viễn)
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        botSettings = { ...botSettings, ...savedConfig };
    } catch (e) { console.error("Lỗi đọc config:", e.message); }
}

let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null; 

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        let queryStr = '';
        
        if (method === 'GET' || method === 'DELETE') {
            queryStr = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        } else {
            queryStr = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        }
        
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryStr).digest('hex');
        const finalUrl = `${endpoint}?${queryStr}&signature=${signature}`;
        
        const response = await binanceApi({ method, url: finalUrl });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

// --- LUỒNG QUẢN LÝ BLACKLIST ---
setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol} (Đã hết thời gian phạt 15 phút)`, "success");
        }
    }
}, 1000);


// --- BẢN VÁ: MONITOR THEO DÕI GIÁ VÀ XỬ LÝ LỆNH ĐÓNG/DCA CHUẨN XÁC ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                // 1. VỊ THẾ CÒN SỐNG -> Cập nhật thông số
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
                b.currentPrice = markP;
                if (b.currentQty !== currentQty) b.currentQty = currentQty; 
                
                // Track Mark Price & Liquidation Price
                b.lastMarkPrice = markP;
                b.lastLiqPrice = parseFloat(realP.liquidationPrice);
                
                b.missCount = 0; // Reset chống lag
                
            } else {
                // 2. VỊ THẾ BIẾN MẤT -> Tìm nguyên nhân
                if (isProcessingDCA.has(b.symbol)) continue;

                // CHỐNG LAG: Miss 4 lần (~4s) mới bắt đầu xử lý đóng
                b.missCount = (b.missCount || 0) + 1;
                if (b.missCount < 4) continue;

                await new Promise(r => setTimeout(r, 1000));

                let reasonOfClose = "MANUAL"; 
                let netPnl = b.pnl; // Fallback
                let avgClosePrice = b.lastMarkPrice;

                try {
                    // Dọn dẹp lệnh chờ thừa mứa (SL/TP)
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
                    }
                } catch(e){}

                // BƯỚC 1: CHECK FORCE CLOSE (THANH LÝ)
                const forceOrders = await binancePrivate('/fapi/v1/forceOrders', 'GET', { 
                    symbol: b.symbol, 
                    startTime: Date.now() - 120000,
                    limit: 5 
                }).catch(() => []);

                const isLiquidated = forceOrders && forceOrders.length > 0;

                if (isLiquidated) {
                    reasonOfClose = "LIQUIDATION";
                    avgClosePrice = parseFloat(forceOrders[0].price || b.lastMarkPrice);
                } else {
                    // BƯỚC 2: CHECK LỊCH SỬ LỆNH TP/SL (Lọc 5 phút đổ lại, sort mới nhất)
                    const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 }).catch(() => []);
                    
                    const closedOrders = allOrders
                        .filter(o => 
                            o.positionSide === b.side && 
                            o.status === 'FILLED' && 
                            (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET')
                        )
                        .sort((a, b) => b.updateTime - a.updateTime); 

                    const closedById = closedOrders.length > 0 ? closedOrders[0] : null;
                    const isRecentOrder = closedById && (Date.now() - closedById.updateTime) < 5 * 60 * 1000;

                    if (isRecentOrder) {
                        reasonOfClose = closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";
                        avgClosePrice = parseFloat(closedById.avgPrice || closedById.stopPrice);
                    }
                }

                // BƯỚC 3: LẤY PNL THỰC TẾ TỪ INCOME (Chuẩn xác nhất)
                try {
                    const incomeHistory = await binancePrivate('/fapi/v1/income', 'GET', { 
                        symbol: b.symbol, 
                        incomeType: 'REALIZED_PNL', 
                        startTime: Date.now() - 300000, 
                        limit: 10 
                    });
                    
                    if (incomeHistory && incomeHistory.length > 0) {
                        // Tính tổng các lệnh chốt trong 1 phút vừa qua để gom đủ PnL (nếu sàn khớp nhiều phần)
                        const recentIncomes = incomeHistory.filter(i => i.time > (Date.now() - 60000));
                        if (recentIncomes.length > 0) {
                            netPnl = recentIncomes.reduce((acc, curr) => acc + parseFloat(curr.income), 0);
                        } else {
                            incomeHistory.sort((a, b) => b.time - a.time);
                            netPnl = parseFloat(incomeHistory[0].income);
                        }
                    } else {
                        throw new Error("No Income Data");
                    }
                } catch(e) {
                    // Fallback về Trades nếu API Income lag
                    const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 }).catch(() => []);
                    const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 60000));
                    
                    if (recent.length > 0) {
                        let totalR = 0, totalV = 0;
                        recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                        avgClosePrice = totalV / recent.reduce((acc, t) => acc + parseFloat(t.qty), 0);
                        const fee = totalV * 0.0005; 
                        netPnl = totalR - fee;
                    }
                }

                // --- DỌN DẸP & THỐNG KÊ ---
                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                const isFinalLong = b.isFinalLong === true; 
                
                // --- XỬ LÝ BLACKLIST ---
                if (netPnl > 0) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                } else {
                    if (isFinalLong || reasonOfClose === 'LIQUIDATION') {
                        // Lệnh Long cuối hoặc Bị Thanh Lý -> Đưa vào blacklist
                        status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    } else {
                        addBotLog(`🔄 ${b.symbol} dính SL/Đóng lệnh vị thế SHORT. Tiếp tục chuỗi lệnh, KHÔNG đưa vào Blacklist.`, "warn");
                    }
                }

                let logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
                if (reasonOfClose === 'LIQUIDATION') logType = "💀 [CHÁY LỆNH]";
                
                const logStatus = netPnl > 0 ? "success" : "error";
                addBotLog(`${logType} ${b.symbol} | ${b.side} | Qty: ${b.currentQty} | DCA: ${b.dcaCount}/${botSettings.maxDca} | ClosePrice: ${avgClosePrice.toFixed(5)} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, logStatus);

                // --- XỬ LÝ NHỒI DCA (KHÔNG DCA NẾU ĐÃ BỊ THANH LÝ) ---
                if (netPnl < 0 && b.side === 'SHORT' && reasonOfClose !== 'LIQUIDATION') {
                    if (!botSettings.isRunning) {
                        addBotLog(`🛑 STOPPING: Bỏ qua DCA cho ${b.symbol} vì bot đang dừng!`, "warn");
                    } else {
                        const jump = b.dcaCount + 1;
                        const currentAccumulatedLoss = (b.totalLossAccumulated || 0) + Math.abs(netPnl);

                        if (jump <= botSettings.maxDca) {
                            openPosition(b.symbol, { 
                                ...b, 
                                dcaCount: jump, 
                                margin: b.firstMargin * Math.pow(2, jump),
                                totalLossAccumulated: currentAccumulatedLoss
                            });
                        } else {
                            openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 10 });
                        }
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- LUỒNG TÍNH TOÁN VÀ ĐẶT LỆNH ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    
    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        
        const acc = await binancePrivate('/fapi/v2/account');
        if (!acc) throw new Error("Không lấy được dữ liệu tài khoản.");

        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

        let qty = 0;
        let margin = 0;

        // KIỂM TRA TRỰC TIẾP TRÊN SÀN TRƯỚC KHI VÀO LỆNH MỚI
        if (!isDCAorLong) {
            const riskCheck = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const hasPos = riskCheck.some(x => Math.abs(parseFloat(x.positionAmt)) > 0);
            if (hasPos) {
                addBotLog(`⚠️ Bỏ qua ${symbol}: Phát hiện đã có vị thế trên sàn!`, "warn");
                isProcessingDCA.delete(symbol);
                return;
            }
        }

        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.capital.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.capital) / 100) 
                : parseFloat(botSettings.capital);

            const desiredQty = (margin * info.maxLeverage) / currentPrice;
            const minQtyRequiredByFloor = 5.05 / currentPrice; 

            const finalQtyBeforeRound = Math.max(desiredQty, minQtyRequiredByFloor);
            qty = Math.ceil(finalQtyBeforeRound / info.stepSize) * info.stepSize;

            if (qty < info.stepSize) qty = info.stepSize;
        }

        const actualMarginUsed = (qty * currentPrice) / info.maxLeverage;
        await exchange.setLeverage(info.maxLeverage, symbol);

        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                
                const dcaHistory = dcaData ? [...dcaData.dcaHistory, entry] : [entry];
                const sumPrices = dcaHistory.reduce((sum, p) => sum + p, 0);
                const simpleAvgEntry = sumPrices / dcaHistory.length;

                let tp = 0, sl = 0;
                let firstQty = dcaData ? dcaData.firstQty : qty;
                let firstProfitUsdt = dcaData ? dcaData.firstProfitUsdt : (qty * entry * (botSettings.tp / 100));
                let accumulatedLoss = dcaData ? dcaData.totalLossAccumulated : 0;

                if (side === 'LONG') {
                    tp = entry * (1 + (botSettings.longTp / 100));
                    sl = entry * (1 - (botSettings.longSl / 100));
                } else {
                    const multiplier = dcaCount + 1;
                    const totalTargetGrossProfit = accumulatedLoss + (multiplier * firstProfitUsdt);
                    tp = simpleAvgEntry - (totalTargetGrossProfit / qty);
                    sl = firstE + (firstE * (botSettings.sl * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, currentPrice: currentPrice, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: qty, virtualTotalQty: qty, virtualTotalCost: qty * entry, 
                    dcaHistory: dcaHistory, isFinalLong: dcaData?.isFinalLong || false,
                    pnl: 0, priceDev: 0,
                    firstQty: firstQty,
                    firstProfitUsdt: firstProfitUsdt,
                    totalLossAccumulated: accumulatedLoss
                });
                
                const modeStr = isDCAorLong ? (dcaData.isFinalLong ? 'LONG_CỨU' : `DCA_${dcaData.dcaCount}`) : 'OPEN';
                addBotLog(`📡 [${modeStr}] ${symbol} | ${side} | Qty: ${qty} | Lev: x${info.maxLeverage} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${entry} | TP: ${sync.tp.toFixed(info.pricePrecision)} | SL: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi vị thế ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(symbol), 2000); 
    }
}

// BẢN VÁ: ĐỔI SANG CONTRACT_PRICE & BẬT BẢO VỆ GIÁ
async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        
        await new Promise(r => setTimeout(r, 600));
        
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, 
            stopPrice: tpPrice.toFixed(info.pricePrecision), 
            closePosition: true, 
            workingType: 'CONTRACT_PRICE', // ÉP DÙNG LAST PRICE
            priceProtect: true // BẢO VỆ TRƯỢT RÂU LÁO
        });
        
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { 
            positionSide: side, 
            stopPrice: slPrice.toFixed(info.pricePrecision), 
            closePosition: true, 
            workingType: 'CONTRACT_PRICE', // ÉP DÙNG LAST PRICE
            priceProtect: true // BẢO VỆ TRƯỢT RÂU LÁO
        });
        
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    
    const visualBlacklist = {};
    const now = Date.now();
    for (const s in status.blackList) {
        const remainingTime = status.blackList[s] - now;
        if (remainingTime > 0) {
            const m = Math.floor(remainingTime / 60000);
            const sRemainder = Math.floor((remainingTime % 60000) / 1000);
            visualBlacklist[s] = `${m}m ${sRemainder}s`;
        }
    }

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: { ...status, blackList: visualBlacklist }, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0.00", availableBalance: "ERR", totalUnrealizedProfit: "0.00" } 
    });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    if(req.body.maxDca !== undefined) botSettings.maxDca = parseInt(req.body.maxDca);
    if(req.body.maxPos !== undefined) botSettings.maxPos = parseInt(req.body.maxPos);
    if(req.body.volVolatility !== undefined) botSettings.volVolatility = parseFloat(req.body.volVolatility);
    if(req.body.tp !== undefined) botSettings.tp = parseFloat(req.body.tp);
    if(req.body.sl !== undefined) botSettings.sl = parseFloat(req.body.sl);
    if(req.body.longTp !== undefined) botSettings.longTp = parseFloat(req.body.longTp);
    if(req.body.longSl !== undefined) botSettings.longSl = parseFloat(req.body.longSl);
    
    // LƯU CẤU HÌNH VÀO FILE
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botSettings, null, 2));
    
    addBotLog(`⚙️ Cập nhật cấu hình thành công (Đã lưu cứng).`, "success");
    res.json({ success: true }); 
});

APP.post('/api/panic-close-all', async (req, res) => {
    try {
        addBotLog("🚨 [PANIC] Kích hoạt lệnh dọn dẹp khẩn cấp toàn sàn!", "error");
        
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const openPos = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        
        for (const p of openPos) {
            try {
                const qty = Math.abs(parseFloat(p.positionAmt));
                const sideToClose = p.positionSide === 'LONG' ? 'SELL' : 'BUY';
                
                await binancePrivate('/fapi/v1/order', 'POST', {
                    symbol: p.symbol,
                    side: sideToClose,
                    positionSide: p.positionSide,
                    type: 'MARKET',
                    quantity: qty
                });
                
                await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol: p.symbol });
                addBotLog(`✅ Đã đóng khẩn cấp ${p.symbol} (${p.positionSide})`, "success");
            } catch(e) { 
                addBotLog(`❌ Lỗi đóng ${p.symbol}: ${e.message}`, "error");
            }
        }
        
        botActivePositions.clear();
        isProcessingDCA.clear();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

async function init() {
    try {
        const ipRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 8000 }).catch(() => ({ data: { ip: "127.0.0.1" } }));
        currentBotIP = ipRes.data.ip; 
        
        console.log(`\n🌍 IP INITIALIZED: ${currentBotIP}`);
        addBotLog(`🌍 IP START: ${currentBotIP}`, "success"); 
        
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { status.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
        addBotLog(`🚀 Hệ thống monitor sẵn sàng.`);
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return; // Nếu Bot đang STOP thì KHÔNG quét lệnh mới

    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        
        if (totalWallet > 0) {
            const availPercent = (availableUsdt / totalWallet) * 100;
            if (!isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                isMarginProtected = true;
                addBotLog(`🚨 [MARGIN_WARN] Đóng băng quét mới. Khả dụng: ${availPercent.toFixed(1)}%`, "error");
            } else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                isMarginProtected = false;
                addBotLog(`🛡️ [MARGIN_OK] Tiếp tục quét lệnh. Khả dụng: ${availPercent.toFixed(1)}%`, "success");
            }
        }
    }

    if (isMarginProtected) return;

    if (botActivePositions.size < botSettings.maxPos && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => 
            (Math.abs(c.c1) >= botSettings.volVolatility || Math.abs(c.c5) >= botSettings.volVolatility) && 
            !status.blackList[c.symbol] && 
            !status.permanentBlacklist[c.symbol] && 
            !botActivePositions.has(`${c.symbol}_SHORT`) &&
            !botActivePositions.has(`${c.symbol}_LONG`)
        );
        
        if (can) {
            addBotLog(`🎯 [MỤC TIÊU] Phát hiện ${can.symbol} đạt điều kiện! Chi tiết biến động -> M1: ${can.c1}% | M5: ${can.c5}% | M15: ${can.c15}%`, "info");
            openPosition(can.symbol);
        }
    }
}, 3000);

setInterval(async () => {
    if (!status.isReady || !currentBotIP) return; 
    try {
        const ipCheckRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        const newIP = ipCheckRes.data.ip;
        
        if (newIP && newIP !== currentBotIP) {
            addBotLog(`⚠️ [NETWORK] IP CHANGE DETECTED! Cũ: ${currentBotIP} -> Mới: ${newIP}`, "warn");
            currentBotIP = newIP; 
        }
    } catch (err) {} 
}, 30000);

// BẢN VÁ: Cập nhật PORT thành 1113
APP.listen(1113, () => {
    console.log(`Server is running on port 1113`);
});
