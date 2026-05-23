import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// CẤU HÌNH NHANH - CÁC THÔNG SỐ CỐ ĐỊNH HỆ THỐNG
// =========================================================================
const MAX_DCA_LEVEL = 3;           // Số lần DCA tối đa cho một cặp vị thế
const MARGIN_PROTECT_LIMIT = 50;    // Dưới 50% Khả dụng/Ví -> Ngừng quét lệnh mới
const MARGIN_RECOVER_LIMIT = 60;    // Đạt lại từ 60% Khả dụng trở lên -> Tiếp tục quét lại
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 10000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; 

// Biến lưu trữ IP hiện tại của Bot
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
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
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

// --- TÁCH BIỆT HOÀN TOÀN LUỒNG QUẢN LÝ BLACKLIST (FIX LỖI ĐÔNG CỨNG MÃI TRÊN HTML) ---
setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Hết thời gian phạt: ${symbol} được giải phóng khỏi Blacklist.`, "success");
        }
    }
}, 5000); // Cứ mỗi 5 giây quét dọn dẹp bộ nhớ một lần độc lập

// --- MONITOR THEO DÕI GIÁ VÀ XỬ LÝ LỆNH ĐÓNG/DCA ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot đã STOP. Tiến hành hủy tất cả TP/SL của bot đang treo...`, "warn");
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) { console.error(`Lỗi hủy lệnh: ${b.symbol}`, err.message); }
            }
            botActivePositions.clear();
            isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
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

                // Check treo lệnh quá 30s
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ Trạng thái treo lệnh chờ khớp của sàn quá 30s tại cặp ${b.symbol}. Ép đóng Market khẩn cấp!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                // ---- VỊ THẾ ĐÃ BIẾN MẤT: XỬ LÝ CHECK ĐÓNG DO TP/SL SÀN HAY ĐÓNG TAY ----
                if (isProcessingDCA.has(b.symbol)) continue;

                // Chờ một chút để lệnh điều kiện chuyển đổi trạng thái trên hệ thống sàn hẳn
                await new Promise(r => setTimeout(r, 1000));

                // 1. Kiểm tra lịch sử lệnh xem có lệnh TP/SL nào vừa khớp (FILLED) không
                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 });
                const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

                let reasonOfClose = "ĐÓNG TAY (USER_MANUAL)"; 
                if (closedById) {
                    reasonOfClose = closedById.type === 'STOP_MARKET' ? "DÍNH CẮT LỖ (STOP_LOSS_MARKET)" : "CẮT LỜI THÀNH CÔNG (TAKE_PROFIT_MARKET)";
                }

                // 2. Thu thập dữ liệu trade chi tiết để tính PnL và phí sàn chính xác
                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 45000));
                
                // Dọn dẹp tàn dư lệnh cũ đang treo của cặp này
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
                const fee = totalV * 0.0005; // Ước tính phí trung bình VIP0 Taker Futures
                const netPnl = totalR - fee;

                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                // Ghi nhận lịch sử phạt Blacklist 15 phút
                status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);

                // LOG CHI TIẾT KHI ĐÓNG VỊ THẾ
                addBotLog(`📦 [CHI TIẾT ĐÓNG LỆNH]
- Cặp Coin: ${b.symbol} | Hướng: ${b.side}
- Nguyên nhân: ${reasonOfClose}
- Số lần đã DCA: ${b.dcaCount}/${botSettings.maxDCA}
- Giá vào trung bình ảo: ${b.virtualTotalCost > 0 ? (b.virtualTotalCost / b.virtualTotalQty).toFixed(5) : b.entryPrice}
- Giá khớp đóng thực tế: ${avgClosePrice.toFixed(5)}
- Mức độ trượt giá so với mốc cài đặt: ${closedById?.type === 'STOP_MARKET' ? Math.abs(((avgClosePrice - b.sl) / b.sl) * 100).toFixed(2) + '%' : 'Không dính'}
- Tổng PnL ròng (đã trừ phí sàn): ${netPnl.toFixed(4)}$`, netPnl > 0 ? "success" : "error");

                // Kích hoạt luồng DCA nếu đóng lỗ do lệnh SHORT thường bị dính SL
                if (netPnl < 0 && b.side === 'SHORT' && reasonOfClose === "DÍNH CẮT LỖ (STOP_LOSS_MARKET)") {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        // Vượt cấp DCA tối đa -> Kích hoạt lệnh LONG bảo vệ tài khoản cứu giá
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
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
        let isForcedMinFloor = false;

        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            // Tính toán lượng Margin mong muốn gốc theo % hoặc số cứng
            margin = botSettings.invValue.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.invValue) / 100) 
                : parseFloat(botSettings.invValue);

            const desiredQty = (margin * info.maxLeverage) / currentPrice;
            const minQtyRequiredByFloor = 5.05 / currentPrice; // Giới hạn Vol > 5$ của sàn

            if (minQtyRequiredByFloor > desiredQty) {
                isForcedMinFloor = true;
            }

            const finalQtyBeforeRound = Math.max(desiredQty, minQtyRequiredByFloor);
            qty = Math.ceil(finalQtyBeforeRound / info.stepSize) * info.stepSize;

            if (qty < info.stepSize) qty = info.stepSize;
        }

        const actualMarginUsed = (qty * currentPrice) / info.maxLeverage;
        await exchange.setLeverage(info.maxLeverage, symbol);
        
        // LOG CHI TIẾT KHI BẮT ĐẦU MỞ HOẶC DCA VỊ THẾ
        addBotLog(`📡 [CHI TIẾT KHỞI TẠO VỊ THẾ]
- Cặp Coin: ${symbol} | Kiểu Luồng: ${isDCAorLong ? (dcaData.isFinalLong ? 'LONG CỨU LỆNH' : `DCA CẤP ${dcaData.dcaCount}`) : 'MỞ MỚI BAN ĐẦU'}
- Hướng Lệnh: ${side} | Đòn bẩy thiết lập: x${info.maxLeverage}
- Khối lượng khớp lệnh (Qty): ${qty.toFixed(info.quantityPrecision)}
- Tổng Volume quy đổi hệ thống: ${(qty * currentPrice).toFixed(2)}$
- Trạng thái ép khối lượng Min Sàn: ${isForcedMinFloor ? 'BẬT (Do vốn % quá nhỏ)' : 'TẮT (Đủ mốc quy định)'}
- Số tiền ký quỹ thực tế giam giữ: ${actualMarginUsed.toFixed(4)}$`);

        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                
                let virtualAvgEntry = entry;
                let currentAccumulatedQty = qty;
                let currentAccumulatedCost = qty * entry;

                if (dcaData) {
                    currentAccumulatedQty = dcaData.virtualTotalQty + qty;
                    currentAccumulatedCost = dcaData.virtualTotalCost + (qty * entry);
                    virtualAvgEntry = currentAccumulatedCost / currentAccumulatedQty;
                }

                let tp = 0, sl = 0;
                if (side === 'LONG') {
                    tp = entry * 1.10;
                    sl = entry * 0.90;
                } else {
                    tp = virtualAvgEntry * (1 - botSettings.posTP / 100);
                    sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: qty,
                    virtualTotalQty: currentAccumulatedQty,   
                    virtualTotalCost: currentAccumulatedCost, 
                    dcaHistory: dcaData ? [...dcaData.dcaHistory, entry] : [entry], 
                    pnl: 0, priceDev: 0, hitTime: null 
                });
                
                // LOG CHI TIẾT KHI KHỚP VÀ TREO TP/SL THÀNH CÔNG
                addBotLog(`🎯 [THÔNG SỐ VỊ THẾ HOẠT ĐỘNG - ${symbol}]
- Giá khớp Entry thực tế: ${entry}
- Mốc chốt lời cài đặt (TP): ${sync.tp.toFixed(info.pricePrecision)}
- Mốc dừng lỗ cài đặt (SL): ${sync.sl.toFixed(info.pricePrecision)}
- Giá trị tích lũy ảo sau phân bổ: Vol=${(currentAccumulatedQty * currentPrice).toFixed(2)}$, EntryTB=${virtualAvgEntry.toFixed(5)}`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Thất bại khi xử lý vị thế ${symbol}: ${e.message}`, "error"); 
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

// --- KHỞI TẠO SERVER APP ---
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status, 
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
    addBotLog(`⚙️ Đồng bộ cấu hình đầu cuối thành công.`, "success");
    res.json({ success: true }); 
});

async function init() {
    try {
        // Lấy IP lần đầu khi khởi chạy
        const ipRes = await axios.get('https://api4.ipify.org?format=json').catch(() => ({ data: { ip: "Không bốc được IP" } }));
        currentBotIP = ipRes.data.ip;
        console.log(`\n🌍 Khởi động môi trường IPv4: ${currentBotIP}`);
        addBotLog(`🌍 Khởi động môi trường IPv4: ${currentBotIP}`, "success");
        
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
        addBotLog(`🚀 Hệ thống giám sát tối ưu hóa cấu hình đã chạy hoàn tất.`);
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// --- VÒNG LẶP KIỂM TRA MARGIN PROTECT ---
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
                addBotLog(`🚨 [CẢNH BÁO KÝ QUỸ] Kích hoạt chế độ đóng băng quét mới. Khả dụng: ${availPercent.toFixed(1)}%`, "error");
            } else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                isMarginProtected = false;
                addBotLog(`🛡️ [HỒI PHỤC KÝ QUỸ] Giải phóng băng tần quét lệnh. Khả dụng: ${availPercent.toFixed(1)}%`, "success");
            }
        }
    }

    if (isMarginProtected) return;

    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => 
            Math.abs(c.c1) >= botSettings.minVol && 
            !status.blackList[c.symbol] && 
            !status.permanentBlacklist[c.symbol] && 
            !botActivePositions.has(`${c.symbol}_SHORT`)
        );
        if (can) openPosition(can.symbol);
    }
}, 3000);

// --- LUỒNG THEO DÕI SỰ THAY ĐỔI IP (Quét định kỳ mỗi 10 giây) ---
setInterval(async () => {
    if (!status.isReady) return;
    try {
        const ipCheckRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        const newIP = ipCheckRes.data.ip;
        
        if (currentBotIP && newIP && newIP !== currentBotIP) {
            addBotLog(`⚠️ [CẢNH BÁO MẠNG] IPv4 của bot đã bị THAY ĐỔI! Cũ: ${currentBotIP} -> Mới: ${newIP}`, "warn");
            currentBotIP = newIP; // Cập nhật lại IP mới làm mốc theo dõi tiếp theo
        }
    } catch (err) {
        // Ghi log nhẹ ra terminal nếu lỗi mạng không bốc được IP tạm thời, tránh spam botLogs trên web
        console.error(`[MẠNG] Không thể kiểm tra IP định kỳ: ${err.message}`);
    }
}, 10000); // 10 giây kiểm tra một lần

APP.listen(9001);
