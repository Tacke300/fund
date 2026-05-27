import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// MẢNG 1: CẤU HÌNH NHANH - CÁC THÔNG SỐ CỐ ĐỊNH HỆ THỐNG
// =========================================================================
const MAX_DCA_LEVEL = 2;            // Số lần DCA tối đa cho một cặp vị thế trước khi Long cứu
const MARGIN_PROTECT_LIMIT = 60;    // Dưới 60% Khả dụng/Ví -> Ngừng quét lệnh mới
const MARGIN_RECOVER_LIMIT = 70;    // Đạt lại từ 70% Khả dụng trở lên -> Tiếp tục quét lại
// =========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================================
// MẢNG 2: KHỞI TẠO ĐỐI TƯỢNG KẾT NỐI API (BINANCE & CCXT)
// =========================================================================
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        recvWindow: 60000, // Tăng lên 60s tránh lỗi lệch thời gian hệ thống hệ thống (Timestamp/RecvWindow)
        adjustForTimeDifference: true 
    } 
});

// =========================================================================
// MẢNG 3: QUẢN LÝ BIẾN TRẠNG THÁI TOÀN CỤC (GLOBAL STATE)
// =========================================================================
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set(); // Chỉ khóa cục bộ coin đang xử lý, không khóa toàn hệ thống
let timestampOffset = 0;
let isMarginProtected = false; 
let currentBotIP = null;

// CHỨC NĂNG: Ghi nhật ký hoạt động hệ thống, đồng bộ hiển thị Terminal NodeJS và UI HTML
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 100) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// CHỨC NĂNG: Xử lý ký mã hóa chữ ký HMAC-SHA256 phục vụ gọi API riêng tư Binance
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

// =========================================================================
// MẢNG 4: LUỒNG QUẢN LÝ BLACKLIST COOLDOWN (HỦY BAN TỰ ĐỘNG)
// =========================================================================
// CHỨC NĂNG: Chạy ngầm định kỳ giải phóng coin ra khỏi danh sách cấm khi hết 15 phút đếm ngược
setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol}`, "success");
        }
    }
}, 5000);

// =========================================================================
// MẢNG 5: MONITOR THEO DÕI GIÁ VÀ XỬ LÝ LỆNH ĐÓNG / DCA CHU KỲ
// =========================================================================
// CHỨC NĂNG: Quản lý vòng đời lệnh mở, quét khẩn cấp cứu treo lệnh, và kiểm soát logic đóng chu kỳ chính xác
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

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                // --- THỐNG KÊ VỊ THẾ ĐANG CHẠY ---
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
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
                // --- XỬ LÝ KHI VỊ THẾ ĐÓNG ---
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

                // FIX LOGIC THEO CHU KỲ: 
                // 1. Chỉ lệnh LỆNH CỨU kết thúc (Bất kể TP hay SL) mới đưa vào Blacklist 15p.
                // 2. Lệnh Đầu + Lệnh DCA: CHỈ khi CHỐT LỜI thành công (netPnl > 0) mới kết thúc chu kỳ -> Cho vào Blacklist 15p.
                // 3. Nếu dính Cắt lỗ (SL) ở lệnh đầu/DCA -> KHÔNG block, giữ mạch chạy lệnh DCA/Long cứu tiếp theo.
                if (b.isFinalLong || netPnl > 0) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                }

                const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
                const logStatus = netPnl > 0 ? "success" : "error";
                addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDCA} | ClosePrice: ${avgClosePrice.toFixed(5)} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, logStatus);

                // TIẾP TỤC CHU KỲ trading NẾU LỆNH GỐC DÍNH SL CẮT LỖ
                if (netPnl < 0 && b.side === 'SHORT') {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        // Kích hoạt vị thế cuối cùng của chu kỳ: LỆNH LONG CỨU (Đánh dấu bằng cờ isFinalLong)
                        openPosition(b.symbol, { ...b, isFinalLong: true, dcaCount: jump, margin: b.firstMargin * 10 });
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// =========================================================================
// MẢNG 6: LUỒNG TÍNH TOÁN VÀ THỰC THI ĐẶT LỆNH SÀN (OPEN POSITION)
// =========================================================================
// CHỨC NĂNG: Tính toán size, đặt lệnh MARKET, tạo lệnh điều kiện bảo vệ TP/SL
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
                if (side === 'LONG') {
                    tp = entry * 1.05;
                    sl = entry * 0.95;
                } else {
                    tp = simpleAvgEntry * (1 - botSettings.posTP / 100);
                    sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
                }

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: qty, virtualTotalQty: qty, virtualTotalCost: qty * entry, 
                    dcaHistory: dcaHistory, pnl: 0, priceDev: 0, hitTime: null,
                    isFinalLong: dcaData ? dcaData.isFinalLong : false // Lưu cờ đánh dấu trạng thái cứu để quản lý chu kỳ đóng
                });
                
                const modeStr = isDCAorLong ? (dcaData.isFinalLong ? 'LONG_CỨU' : `DCA_${dcaData.dcaCount}`) : 'OPEN';
                addBotLog(`📡 [${modeStr}] ${symbol} | ${side} | Lev: x${info.maxLeverage} | Margin: ${actualMarginUsed.toFixed(2)}$ | Entry: ${entry} | TP: ${sync.tp.toFixed(info.pricePrecision)} | SL: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { 
        const errorMsg = e.response?.data?.msg || e.message;
        addBotLog(`❌ Lỗi mở lệnh ${symbol}: ${errorMsg}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(symbol), 2000); 
    }
}

// CHỨC NĂNG: Đồng bộ treo sẵn lệnh chốt lời, dừng lỗ tự động lên sàn giao dịch Binance
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

// =========================================================================
// MẢNG 7: KHỞI TẠO SERVER APP API ROUTE (ĐỒNG BỘ GIAO DIỆN WEB HTML)
// =========================================================================
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

// API ROUTE: Đọc trạng thái đồng bộ UI Web -> FIX biến đổi dãy số Blacklist thành mốc MM:SS đếm ngược
APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    
    // Tạo danh sách Blacklist đếm ngược định dạng MM:SS gửi trực tiếp lên giao diện HTML
    const formattedBlacklist = {};
    const now = Date.now();
    for (const symbol in status.blackList) {
        const timeLeft = status.blackList[symbol] - now;
        if (timeLeft > 0) {
            const minutes = Math.floor(timeLeft / 60000);
            const seconds = Math.floor((timeLeft % 60000) / 1000);
            formattedBlacklist[symbol] = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: {
            ...status,
            blackList: formattedBlacklist // Ghi đè cấu trúc đếm ngược thời gian hỗ trợ HTML hiển thị
        }, 
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
    addBotLog(`⚙️ Cập nhật cấu hình thành công.`, "success");
    res.json({ success: true }); 
});

// =========================================================================
// MẢNG 8: HÀM KHỞI CHẠY CORE HỆ THỐNG VÀ THU THẬP THÔNG TIN SÀN (INIT)
// =========================================================================
async function init() {
    try {
        const ipRes = await axios.get('https://api4.ipify.org?format=json').catch(() => ({ data: { ip: "Không bốc được IP" } }));
        currentBotIP = ipRes.data.ip;
        console.log(`\n🌍 IP: ${currentBotIP}`);
        addBotLog(`🌍 IP: ${currentBotIP}`, "success");
        
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

// CHỨC NĂNG: Lấy dữ liệu Candidates phân tích được từ cổng luồng quét tín hiệu 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// =========================================================================
// MẢNG 9: VÒNG LẶP KIỂM TRA MARGIN PROTECT VÀ QUÉT LỆNH ĐA CẶP SONG SONG
// =========================================================================
// CHỨC NĂNG CẢI TIẾN: Quét độc lập không block chùm, bắt trọn coin đủ Vol m1 hoặc m5, in log biến động 3 khung rõ ràng
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

    // Kiểm tra slot trống vị thế của hệ thống trước khi quét lệnh mới
    if (botActivePositions.size >= botSettings.maxPositions) return;

    // CẢI TIẾN LUỒNG: Lọc ra TẤT CẢ các coin đủ điều kiện minVol trên khung m1 HOẶC khung m5
    const validCandidates = status.candidatesList.filter(c => {
        const matchM1 = c.c1 && Math.abs(c.c1) >= botSettings.minVol; // c1: khung m1
        const matchM5 = c.c2 && Math.abs(c.c2) >= botSettings.minVol; // c2: khung m5

        return (matchM1 || matchM5) && 
               !status.blackList[c.symbol] && // Lúc này HTML truyền về chuỗi đếm ngược, nhưng bộ nhớ trong code gốc vẫn nhận dạng key tồn tại để chặn
               !status.permanentBlacklist[c.symbol] && 
               !botActivePositions.has(`${c.symbol}_SHORT`) &&
               !isProcessingDCA.has(c.symbol); // Không khóa toàn hệ thống, coin nào xử lý xong tự động giải phóng quét tiếp coin khác
    });

    // Thực thi mở vị thế tuần tự cho các coin đạt chuẩn tín hiệu đa khung
    for (const can of validCandidates) {
        if (botActivePositions.size >= botSettings.maxPositions) break;

        // Trích xuất dữ liệu biến động 3 khung thời gian hỗ trợ log đối soát giao diện HTML
        const volM1 = can.c1 ? `${can.c1}%` : '0%';
        const volM5 = can.c2 ? `${can.c2}%` : '0%';
        const volM15 = can.c3 ? `${can.c3}%` : '0%';

        // CẢI TIẾN: Ghi log chi tiết thông số biến động 3 khung ngay khi lệnh được kích hoạt để kiểm soát đầu vào
        addBotLog(`🎯 Đủ ĐK mở lệnh: ${can.symbol} | Biến động 3 khung [1M: ${volM1} | 5M: ${volM5} | 15M: ${volM15}]`, "info");

        openPosition(can.symbol);
    }
}, 3000);

// =========================================================================
// MẢNG 10: LUỒNG THEO DÕI SỰ THAY ĐỔI ĐỊA CHỈ IP MẠNG (WAN IP)
// =========================================================================
setInterval(async () => {
    if (!status.isReady) return;
    try {
        const ipCheckRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 5000 });
        const newIP = ipCheckRes.data.ip;
        
        if (!currentBotIP && newIP) {
            currentBotIP = newIP;
            return;
        }

        if (currentBotIP && newIP && newIP !== currentBotIP) {
            addBotLog(`⚠️ [NETWORK] IP CHANGE! Cũ: ${currentBotIP} -> Mới: ${newIP}`, "warn");
            currentBotIP = newIP;
        }
    } catch (err) {}
}, 30000);

APP.listen(9001);
