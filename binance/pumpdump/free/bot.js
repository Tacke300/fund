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
const MAX_DCA_LEVEL = 2;           // Số lần DCA tối đa cho một cặp vị thế
const MARGIN_PROTECT_LIMIT = 60;    // Dưới 60% Khả dụng/Ví -> Ngừng quét lệnh mới
const MARGIN_RECOVER_LIMIT = 70;    // Đạt lại từ 70% Khả dụng trở lên -> Tiếp tục quét lại
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, 'bot_settings.json');

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

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };

// Tự động tải cấu hình lưu trữ vĩnh viễn
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
            botSettings = JSON.stringify(data) !== '{}' ? JSON.parse(data) : botSettings;
            console.log("💾 [SETTINGS] Đã tải thành công cấu hình từ file bot_settings.json");
        } else {
            saveSettings();
        }
    } catch (e) { console.error("❌ Lỗi đọc file cấu hình:", e.message); }
}

function saveSettings() {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings, null, 4), 'utf8'); } catch (e) { console.error("❌ Lỗi ghi file cấu hình:", e.message); }
}

loadSettings();

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
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
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

// --- HÀM XỬ LÝ RIÊNG BIỆT CHO TỪNG COIN (TỐI ƯU TỐC ĐỘ + CHECK CHẶT CHẼ) ---
async function processSinglePositionMonitor(key, b, posRisk) {
    try {
        // Lấy thông tin vị thế thực tế và GIÁ MARK thực tế từ mảng posRisk tập trung
        const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key);
        const hasPositionReal = realP && Math.abs(parseFloat(realP.positionAmt)) > 0;
        
        if (hasPositionReal) {
            // --- TRƯỜNG HỢP 1: VỊ THẾ ĐANG MỞ ---
            const currentQty = Math.abs(parseFloat(realP.positionAmt));
            const markP = parseFloat(realP.markPrice);
            
            // Cập nhật liên tục các thông số động nhảy thời gian thực
            b.currentPrice = markP; 
            b.pnl = parseFloat(realP.unRealizedProfit);
            b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

            if (b.currentQty !== currentQty) { 
                b.currentQty = currentQty; 
                b.hitTime = null; 
            }

            const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
            const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

            if (hitTP || hitSL) {
                if (!b.hitTime) b.hitTime = Date.now();
                if (Date.now() - b.hitTime > 30000) {
                    addBotLog(`⚠️ Treo lệnh >30s tại ${b.symbol}. Ép đóng MARKET!`, "warn");
                    await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                }
            } else { b.hitTime = null; }
        } else {
            // --- TRƯỜNG HỢP 2: VỊ THẾ BẰNG 0 (ĐÃ BỊ CHỐT HOẶC CHƯA KHỚP) ---
            if (isProcessingDCA.has(b.symbol)) return;

            // Lấy giá Mark cuối cùng từ hệ thống sàn cung cấp để đối chiếu vùng giá
            if (!realP) return;
            const lastMarkPrice = parseFloat(realP.markPrice);

            // 🛡️ KHÓA AN TOÀN BẰNG GIÁ: Giá thị trường phải lọt vào vùng SL hoặc TP thì mới xử lý tiếp
            const priceHitTP = (b.side === 'SHORT' && lastMarkPrice <= b.tp) || (b.side === 'LONG' && lastMarkPrice >= b.tp);
            const priceHitSL = (b.side === 'SHORT' && lastMarkPrice >= b.sl) || (b.side === 'LONG' && lastMarkPrice <= b.sl);

            if (!priceHitTP && !priceHitSL) {
                return; // Giá chưa chạm vùng chốt -> Vị thế ảo hoặc lag sàn, giữ nguyên không thao tác dữ liệu
            }

            // Chờ 1.2 giây để sàn Binance kết xuất đồng bộ xong trạng thái Order
            await new Promise(r => setTimeout(r, 1200));

            // Quét lịch sử Order xem có đúng là hệ thống chốt tự động (FILLED) không
            const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 8 }).catch(() => []);
            const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

            // 🚫 KHÔNG XỬ LÝ LỆNH ẢO: Nếu lệnh chốt hệ thống không tồn tại, thoát ra kiểm tra lại vòng sau
            if (!closedById) return; 

            let reasonOfClose = closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";

            // Lấy PnL thực tế phát sinh của giao dịch
            const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 }).catch(() => []);
            const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 60000));
            if (recent.length === 0) return;

            let totalR = 0, totalV = 0, avgClosePrice = 0;
            recent.forEach(t => { 
                totalR += parseFloat(t.realizedPnl); 
                totalV += (parseFloat(t.price) * parseFloat(t.qty)); 
            });
            avgClosePrice = totalV / recent.reduce((acc, t) => acc + parseFloat(t.qty), 0);
            const netPnl = totalR - (totalV * 0.0005);

            // Dọn sạch các lệnh Stop bảo vệ cũ còn treo
            try {
                const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                    await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                }
            } catch(e){}

            // Giải phóng bộ nhớ cục bộ của bot
            botActivePositions.delete(key);
            status.botClosedCount++; 
            status.botPnLClosed += netPnl;

            if (netPnl > 0) {
                status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
            } else {
                if (b.isFinalLong === true) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                } else {
                    addBotLog(`🔄 ${b.symbol} dính SL vị thế SHORT. Tiếp tục chuỗi lệnh, KHÔNG đưa vào Blacklist.`, "warn");
                }
            }

            const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
            const logStatus = netPnl > 0 ? "success" : "error";
            addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDCA} | ClosePrice: ${avgClosePrice.toFixed(5)} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, logStatus);

            // Khởi động chu kỳ DCA kế tiếp khi xác thực lỗ thực tế
            if (netPnl < 0 && b.side === 'SHORT') {
                const jump = b.dcaCount + 1;
                const currentAccumulatedLoss = (b.totalLossAccumulated || 0) + Math.abs(netPnl);

                if (jump <= botSettings.maxDCA) {
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
    } catch (err) {
        console.error(`❌ Lỗi luồng xử lý riêng của ${b.symbol}:`, err.message);
    }
}

// --- MONITOR THEO DÕI GIÁ TOÀN CỤC (CHẠY SONG SONG KHÔNG DELAY CHÉO) ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot STOP. Hủy toàn bộ TP/SL đang treo...`, "warn");
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) { console.error(`Lỗi hủy: ${b.symbol}`, err.message); }
            }
            botActivePositions.clear();
            isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

        // Lấy danh sách trạng thái gộp một lần (Tiết kiệm Rate Limit tối đa)
        const posRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        
        if (posRisk && botActivePositions.size > 0) {
            const promises = [];
            for (let [key, b] of botActivePositions) {
                promises.push(processSinglePositionMonitor(key, b, posRisk));
            }
            await Promise.all(promises);
        }
    } catch (e) { console.error("Monitor Toàn Cục Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- LUỒNG VÀO LỆNH VÀ ĐẶT LỆNH BẢO VỆ CHỐT ---
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

        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.invValue.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.invValue) / 100) 
                : parseFloat(botSettings.invValue);

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
                let firstProfitUsdt = dcaData ? dcaData.firstProfitUsdt : (qty * entry * (botSettings.posTP / 100));
                let accumulatedLoss = dcaData ? dcaData.totalLossAccumulated : 0;

                if (side === 'LONG') {
                    tp = entry * 1.15;
                    sl = entry * 0.85;
                } else {
                    const multiplier = dcaCount + 1;
                    const totalTargetGrossProfit = accumulatedLoss + (multiplier * firstProfitUsdt);
                    tp = simpleAvgEntry - (totalTargetGrossProfit / qty);
                    sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, currentPrice: currentPrice,
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: qty, virtualTotalQty: qty, virtualTotalCost: qty * entry, 
                    dcaHistory: dcaHistory, isFinalLong: dcaData?.isFinalLong || false,
                    pnl: 0, priceDev: 0, hitTime: null,
                    firstQty: firstQty,
                    firstProfitUsdt: firstProfitUsdt,
                    totalLossAccumulated: accumulatedLoss
                });
                
                const modeStr = isDCAorLong ? (dcaData.isFinalLong ? 'LONG_CỨU' : `DCA_${dcaData.dcaCount}`) : 'OPEN';
                addBotLog(`📡 [${modeStr}] ${symbol} | ${side} | Lev: x${info.maxLeverage} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${entry} | TP: ${sync.tp.toFixed(info.pricePrecision)} | SL: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi vị thế ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(symbol), 2000); 
    }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await new Promise(r => setTimeout(r, 600));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

// Đã tích hợp đầy đủ: Entry, TP, SL, CurrentPrice (Giá hiện tại) cho Web UI hiển thị liền
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
        activePositions: Array.from(botActivePositions.values()).map(p => ({
            symbol: p.symbol,
            side: p.side,
            entryPrice: p.entryPrice,
            tp: p.tp,
            sl: p.sl,
            currentPrice: p.currentPrice || p.entryPrice, // Đảm bảo luôn có giá hiện tại nhảy liên tục
            pnl: p.pnl,
            priceDev: p.priceDev,
            dcaCount: p.dcaCount,
            margin: p.currentMargin
        })), 
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
    botSettings.maxDCA = parseInt(botSettings.maxDCA);
    botSettings.maxPositions = parseInt(botSettings.maxPositions);
    botSettings.minVol = parseFloat(botSettings.minVol);
    
    saveSettings(); 
    
    addBotLog(`⚙️ Cập nhật & Tự động sao lưu cấu hình vĩnh viễn thành công.`, "success");
    res.json({ success: true }); 
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
    if (!status.isReady || !botSettings.isRunning) return;

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

    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => 
            (Math.abs(c.c1) >= botSettings.minVol || Math.abs(c.c5) >= botSettings.minVol) && 
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

// Chạy ứng dụng trên cổng 1111
APP.listen(1111, () => {
    console.log("⚡ Bot Server running at http://localhost:1111");
});
