import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';
// dieu kiện
import { checkEntryCondition } from './dieukien.js';
// =========================================================================
// CẤU HÌNH NHANH - CÁC THÔNG SỐ CỐ ĐỊNH HỆ THỐNG
// =========================================================================
const MAX_DCA_LEVEL = 2;            // Số lần DCA tối đa cho một cặp vị thế
const MARGIN_PROTECT_LIMIT = 60;    // Dưới 60% Khả dụng/Ví -> Ngừng quét lệnh mới
const MARGIN_RECOVER_LIMIT = 70;    // Đạt lại từ 70% Khả dụng trở lên -> Tiếp tục quét lại
// Cấu hình DCA & Cứu thương
const MARGIN_XEDAP = 1;       // DCA xe đạp: x1 margin đầu
const MARGIN_DIANGUC = 2;     // DCA địa ngục: x2 margin đầu
const RESCUE_STEP = 0.01;     // Bước giá 1% để dịch TP cứu thương
// =========================================================================

// Cấu hình đường dẫn thư mục hiện tại cho Node.js ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Khởi tạo các client kết nối API Binance (Axios cho lệnh REST, CCXT cho quản lý lệnh)
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

// Lưu trữ trạng thái bot, cài đặt, các vị thế đang mở và blacklist
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 

let currentBotIP = null; 

// Hàm ghi log sự kiện vào mảng log của status và console
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Hàm gửi request private tới Binance với chữ ký (HMAC SHA256) và xử lý đồng bộ thời gian
async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        // Tự động đồng bộ lại thời gian nếu gặp lỗi lệch timestamp từ Binance
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

// --- LUỒNG QUẢN LÝ BLACKLIST ---
// Kiểm tra định kỳ mỗi giây để gỡ bỏ lệnh cấm (ban) sau 15 phút
setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol} (Đã hết thời gian phạt 15 phút)`, "success");
        }
    }
}, 1000);

// --- MONITOR THEO DÕI GIÁ VÀ XỬ LÝ LỆNH ĐÓNG/DCA ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        // Xử lý khi Bot bị dừng: hủy toàn bộ lệnh TP/SL đang treo
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

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        // Theo dõi các vị thế đang chạy để cập nhật PnL và kiểm tra TP/SL
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;



                
                if (b.currentQty !== currentQty) { 
                    b.currentQty = currentQty; 
                    b.hitTime = null; 
                }



                // 1. Tính giá trung bình DCA hiện tại
// Thay đoạn logic chốt hòa cũ trong priceMonitor:
// 1. Tính giá trung bình DCA (Avg Entry)
const avgEntry = b.dcaHistory.reduce((sum, p) => sum + p, 0) / b.dcaHistory.length;

// 2. Chỉ kiểm tra khi đã DCA hoặc đã vào chế độ cứu thương
if (b.dcaCount > 0 || b.isFinalLong) {
    
    // Logic mới: Đóng Market khi giá vi phạm vùng giá trung bình (Avg Entry)
    let isViolation = false;
    
    if (b.side === 'LONG') {
        // LONG: Giá hiện tại (markP) phải >= AvgEntry. 
        // Nếu < AvgEntry tức là đang lỗ/vi phạm -> Đóng Market.
        if (markP < avgEntry) isViolation = true;
    } else {
        // SHORT: Giá hiện tại (markP) phải <= AvgEntry.
        // Nếu > AvgEntry tức là đang lỗ/vi phạm -> Đóng Market.
        if (markP > avgEntry) isViolation = true;
    }

    // 3. Thực hiện đóng nếu vi phạm
    if (isViolation) {
        addBotLog(`⚠️ [CẮT LỖ VÙNG HÒA VỐN] ${b.symbol} (${b.side}) | Giá: ${markP} | Avg: ${avgEntry.toFixed(2)}`, "warn");
        
        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
        
        // Hủy các lệnh TP/SL treo
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
        }
        
        botActivePositions.delete(key);
        continue;
    }
}
// 3. Kiểm tra chốt lời hòa vốn (Chỉ khi đã có ít nhất 1 lần DCA trở lên)
if (b.dcaCount > 0) {
    const isBreakevenReached = (b.side === 'SHORT' && markP <= breakEvenPrice) || 
                              (b.side === 'LONG' && markP >= breakEvenPrice);



                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                // Nếu giá chạm TP/SL mà lệnh vẫn treo quá 30s, ép đóng bằng lệnh MARKET
                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ Treo lệnh >30s tại ${b.symbol}. Ép đóng MARKET!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                // Vị thế đã đóng: tính toán kết quả và xử lý logic DCA hoặc Blacklist
                if (isProcessingDCA.has(b.symbol)) continue;

                await new Promise(r => setTimeout(r, 1000));

                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 });
                const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

                let reasonOfClose = "MANUAL"; 
                if (closedById) {
                    reasonOfClose = closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";
                }

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 45000));
                
                try {
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch(e){}

                let totalR = 0, totalV = 0, avgClosePrice = 0;
                if (recent.length > 0) {
                    recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                    avgClosePrice = totalV / recent.reduce((acc, t) => acc + parseFloat(t.qty), 0);
                }
                const fee = totalV * 0.0005; 
                const netPnl = totalR - fee;

                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                const isFinalLong = b.isFinalLong === true; 
                if (netPnl > 0) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                } } else if (!b.isFinalLong) {
    // Chỉ cần đánh dấu trạng thái, không cần mở lệnh mới
    // Cập nhật lại đối tượng trong Map để theo dõi
    b.isFinalLong = true; 
    addBotLog(`🛡️ [CỨU THƯƠNG] ${b.symbol} kích hoạt chế độ chốt hòa khi giá hồi!`, "warn");
}

                const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
                const logStatus = netPnl > 0 ? "success" : "error";
                addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDCA} | ClosePrice: ${avgClosePrice.toFixed(5)} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, logStatus);

                // --- BẮT ĐẦU ĐOẠN MỚI: DCA + CỨU THƯƠNG ---
                // Thay đoạn cũ trong priceMonitor bằng logic linh hoạt này:
if (netPnl < 0) { 
    // Kiểm tra xem đã đến ngưỡng DCA chưa
    const jump = b.dcaCount + 1;
    if (jump <= botSettings.maxDCA) {
        // DCA tiếp tục cùng chiều hiện tại
        const marginMultiplier = (jump === 1) ? MARGIN_XEDAP : MARGIN_DIANGUC;
        openPosition(b.symbol, { 
            ...b, 
            dcaCount: jump, 
            margin: b.firstMargin * marginMultiplier,
            totalLossAccumulated: (b.totalLossAccumulated || 0) + Math.abs(netPnl)
        }, b.side); // Truyền lại chính side đang chạy
    } else if (!b.isFinalLong) {
        // Hết DCA, thực hiện lệnh Cứu thương (Đảo chiều)
        // Nếu đang SHORT -> Cứu bằng LONG, nếu đang LONG -> Cứu bằng SHORT
        const rescueSide = (b.side === 'SHORT') ? 'LONG' : 'SHORT';
        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 2 }, rescueSide);
    }
}
                // --- KẾT THÚC ĐOẠN MỚI ---
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- LUỒNG TÍNH TOÁN VÀ ĐẶT LỆNH ---
async function openPosition(symbol, dcaData = null, forcedSide = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    
    // Logic: Nếu có dcaData (đang DCA), lấy theo side của dcaData. 
    // Nếu có forcedSide (từ quét lệnh mới), ưu tiên dùng nó.
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCAorLong = dcaData !== null;
    
    // ... (phần code còn lại giữ nguyên)
}
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

        // Tính toán khối lượng dựa trên cài đặt hoặc thông số DCA
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

        // Mở vị thế mới
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
               /* const entry = parseFloat(p.entryPrice);
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
                    // Cấu trúc TP luỹ tiến: Thu hồi lỗ cũ + mục tiêu lãi mới
                    const multiplier = dcaCount + 1;
                    const totalTargetGrossProfit = accumulatedLoss + (multiplier * firstProfitUsdt);

                    tp = simpleAvgEntry - (totalTargetGrossProfit / qty);

                    // SL luỹ tiến theo cấp độ DCA
                    sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);*/
                // ... sau khi order thành công và lấy được biến p ...
const entry = parseFloat(p.entryPrice);
const firstE = dcaData ? dcaData.firstEntry : entry;
const dcaCount = dcaData ? dcaData.dcaCount : 0;
const dcaHistory = dcaData ? [...dcaData.dcaHistory, entry] : [entry];
const simpleAvgEntry = dcaHistory.reduce((sum, p) => sum + p, 0) / dcaHistory.length;

let tp, sl;
// Xác định hệ số hướng (LONG = 1, SHORT = -1)
const dir = (side === 'LONG') ? 1 : -1;

if (dcaData?.isFinalLong) {
    // Logic riêng cho Cứu thương nếu muốn
    tp = entry * (1 + (dir * 0.05)); 
    sl = entry * (1 - (dir * 0.05));
} else {
    // Tính toán TP/SL chung cho cả 2 chiều dựa trên dir
    // TP: Lấy theo trung bình giá (simpleAvgEntry) để DCA hiệu quả
    const targetProfit = (dcaCount + 1) * (qty * entry * (botSettings.posTP / 100));
    const accumulatedLoss = dcaData?.totalLossAccumulated || 0;
    
    // Công thức TP chung: TP = Entry + (Direction * (Lợi nhuận cần đạt / Qty))
    tp = simpleAvgEntry + (dir * ((accumulatedLoss + targetProfit) / qty));
    
    // SL: Theo phần trăm cài đặt
    sl = entry * (1 - (dir * (botSettings.posSL * (dcaCount + 1) / 100)));
}

const sync = await syncTPSL(symbol, side, info, tp, sl);
// ... lưu vào botActivePositions ...
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
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
        setTimeout(() => isProcessingDCA.delete(symbol), 3000); 
    }
}

// Hàm đồng bộ lệnh TP/SL lên Binance
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

// Cấu hình Express API server
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

// Endpoint xem trạng thái bot
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

// Endpoint cập nhật cài đặt
APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    botSettings.maxDCA = parseInt(botSettings.maxDCA);
    botSettings.maxPositions = parseInt(botSettings.maxPositions);
    botSettings.minVol = parseFloat(botSettings.minVol);
    addBotLog(`⚙️ Cập nhật cấu hình thành công.`, "success");
    res.json({ success: true }); 
});

// Khởi tạo hệ thống (IP, thời gian, markets, thông tin exchange)
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

// Lấy danh sách ứng viên (tín hiệu trade) từ một source bên ngoài
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// Vòng lặp chính quản lý // ... (phần code bên trên giữ nguyên)

// Vòng lặp chính quản lý rủi ro Margin và quét lệnh mới
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

    /* --- LOGIC CŨ ĐÃ COMMENT LẠI ---
       const can = status.candidatesList.find(c => ... ); 
    */

    // Kiểm tra điều kiện mở lệnh từ danh sách ứng viên
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const entryData = status.candidatesList.find(c => checkEntryCondition(c, botSettings, status, botActivePositions));
        
        if (entryData) {
            addBotLog(`🎯 [MỤC TIÊU] ${entryData.symbol} đạt điều kiện tại ${entryData.reason}! Chiều: ${entryData.side}`, "info");
            openPosition(entryData.symbol, null, entryData.side);
        }
    }
}, 3000); 

// ... (phần code phía dưới giữ nguyên)

// Kiểm tra thay đổi IP để cảnh báo hệ thống
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

APP.listen(9001);

