import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================================
// CẤU HÌNH NHANH - ÔNG SỬA THÔNG SỐ Ở ĐÂY TÙY Ý
// =========================================================================
const MAX_DCA_LEVEL = 3;           // Số lần DCA tối đa cho một cặp vị thế
const MARGIN_PROTECT_LIMIT = 50;    // Dưới 50% Khả dụng/Ví -> Kích hoạt bảo vệ, NGỪNG quét lệnh mới
const MARGIN_RECOVER_LIMIT = 60;    // Đạt lại từ 60% Khả dụng trở lên -> PHỤC HỒI bảo vệ, TIẾP TỤC quét
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
let botActivePositions = new Map(); // Danh sách các vị thế do bot quản lý duy nhất
let isProcessingDCA = new Set();
let timestampOffset = 0;
let isMarginProtected = false; // Biến trạng thái theo dõi chốt chặn bảo vệ ký quỹ

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
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

// --- MONITOR THEO DÕI GIÁ VÀ XỬ LÝ LỆNH ĐÓNG/DCA ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot đã STOP. Tiến hành hủy TP/SL treo và xóa bộ nhớ theo dõi...`, "warn");
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) { console.error(`Lỗi hủy lệnh khi Stop: ${b.symbol}`, err.message); }
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

                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ ${b.symbol} treo lệnh chờ khớp của sàn >30s. Tiến hành đóng Market khẩn cấp!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 30000));
                
                if (recent.length === 0) {
                    addBotLog(`⚠️ Vị thế ${b.symbol} biến mất không rõ nguyên do (Do đóng tay bên ngoài App). Hủy theo dõi!`, "warn");
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    botActivePositions.delete(key);
                    continue;
                }

                const lastTrade = recent[0]; 
                
                try {
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch(e){}

                let totalR = 0, totalV = 0;
                recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                const fee = totalV * 0.001; const netPnl = totalR - fee;

                const currentRiskData = posRisk.find(p => p.symbol === b.symbol);
                const checkPrice = currentRiskData ? parseFloat(currentRiskData.markPrice) : lastTrade.price;
                const slDiff = Math.abs((checkPrice - b.sl) / b.sl) * 100;

                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                if (netPnl > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 BOT CHỐT LỜI ${b.symbol} | Net PnL: ${netPnl.toFixed(2)}$`);
                } else {
                    if (slDiff > 0.5) {
                        status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                        addBotLog(`🛑 Phát hiện ông chủ động ĐÓNG TAY cắt lỗ cặp ${b.symbol} trên App (Cách mốc SL ${slDiff.toFixed(2)}%). Hủy luồng DCA!`, "warn");
                    } else {
                        const jump = b.dcaCount + 1;
                        if (jump <= botSettings.maxDCA) {
                            openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                        } else {
                            openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                        }
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- LUỒNG TÍNH TOÁN VÀ ĐẶT LỆNH (CHỨA LOGIC KIỂM TRA MIN SÀN CHUYÊN SÂU) ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    
    const isDCAorLong = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        
        const acc = await binancePrivate('/fapi/v2/account');
        if (!acc) throw new Error("Không lấy được thông tin tài khoản từ sàn.");

        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

        let qty = 0;
        let margin = 0;

        if (isDCAorLong) {
            // [LUỒNG DCA HOẶC LONG CỨU LỆNH]: Giữ nguyên quy tắc tính vốn lũy tiến
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            // [LUỒNG MỞ LỆNH MỚI HOÀN TOÀN]: Thuật toán gánh vốn nhỏ - Ép Min Sàn khi cần
            
            // 1. Tính toán lượng Margin mong muốn từ cài đặt (% hoặc số tiền cứng)
            margin = botSettings.invValue.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.invValue) / 100) 
                : parseFloat(botSettings.invValue);

            // 2. Quy đổi ra Số lượng (Qty) mong muốn dựa trên Margin và đòn bẩy Max của coin đó
            const desiredQty = (margin * info.maxLeverage) / currentPrice;

            // 3. Tính số lượng tối thiểu bắt buộc để đạt mốc Vol > 5 USDT của Binance
            // Đặt mốc đệm an toàn 5.05 USDT để bốc trọn mọi biến động hoặc bước nhảy của các coin đặc thù (5.2, 5.7)
            const minQtyRequiredByFloor = 5.05 / currentPrice;

            // 4. Lấy giá trị lớn nhất: Đảm bảo nếu lượng mong muốn quá nhỏ, hệ thống sẽ tự lấy khối lượng Min sàn
            const finalQtyBeforeRound = Math.max(desiredQty, minQtyRequiredByFloor);

            // 5. Làm tròn lên khớp hoàn toàn theo quy chuẩn stepSize của sàn
            qty = Math.ceil(finalQtyBeforeRound / info.stepSize) * info.stepSize;

            // Chốt chặn kỹ thuật vật lý của đồng coin
            if (qty < info.stepSize) qty = info.stepSize;
        }

        // Khấu trừ tính toán lượng Margin thực tế bị giam phục vụ mục đích ghi Log theo dõi
        const actualMarginUsed = (qty * currentPrice) / info.maxLeverage;

        // Tiến hành set đòn bẩy tối đa cấu hình cho coin
        await exchange.setLeverage(info.maxLeverage, symbol);
        
        addBotLog(`⚡ Khởi chạy lệnh: ${symbol} | Khối lượng: ${qty.toFixed(info.quantityPrecision)} | Vol quy đổi: ${(qty * currentPrice).toFixed(2)}$ | Ký quỹ thực tế: ${actualMarginUsed.toFixed(4)}$`);

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
                addBotLog(`✅ BOT đã khớp vị thế ${symbol} (Cấp ${dcaCount}) | Tổng Vol chạy: ${(qty * currentPrice).toFixed(2)}$`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Thất bại khi mở lệnh ${symbol}: ${e.message}`, "error"); 
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

// --- KHỞI TẠO HỆ THỐNG VÀ KIỂM TRA ĐỊNH DẠNG IPV4 ---
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
    addBotLog(`⚙️ Đã cập nhật cấu hình: Run=${botSettings.isRunning}, MaxDCA=${botSettings.maxDCA}`, "success");
    res.json({ success: true }); 
});

async function init() {
    try {
        // Gọi thẳng api4 để lấy định dạng thuần IPv4, loại bỏ hoàn toàn hiện tượng dính IPv6 lai
        const ipRes = await axios.get('https://api4.ipify.org?format=json').catch(() => ({ data: { ip: "Không bốc được IP" } }));
        console.log(`\n🌍 Bạn đang chạy bot trên IPv4: ${ipRes.data.ip}`);
        
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;

            if (maxLev < 20) {
                status.permanentBlacklist[s.symbol] = true;
                return;
            }

            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
        addBotLog(`🚀 Bot Ready (IPv4: ${ipRes.data.ip}) | Đã quét và loại bỏ vĩnh viễn các coin có Max Leverage < x20`);
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// --- VÒNG LẶP QUÉT TÌM COIN VÀ CHECK TRẠNG THÁI BẢO VỆ KÝ QUỸ TỰ ĐỘNG ---
setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return;

    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) delete status.blackList[symbol]; 
    }

    // Logic Quản Lý Vùng Đệm Bảo Vệ Ký Quỹ (Margin Buffer)
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        
        if (totalWallet > 0) {
            const availPercent = (availableUsdt / totalWallet) * 100;

            // Kịch bản A: Tài khoản tụt sâu qua mốc giới hạn bảo vệ
            if (!isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                isMarginProtected = true;
                addBotLog(`🚨 KÍCH HOẠT BẢO VỆ MARGIN: Khả dụng (${availPercent.toFixed(1)}%) < ${MARGIN_PROTECT_LIMIT}%. Đã khóa luồng quét mở vị thế mới!`, "error");
            } 
            // Kịch bản B: Margin hồi phục vượt ngưỡng xả chốt bảo vệ
            else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                isMarginProtected = false;
                addBotLog(`🛡️ MARGIN PHỤC HỒI: Khả dụng (${availPercent.toFixed(1)}%) >= ${MARGIN_RECOVER_LIMIT}%. Mở khóa, tiếp tục quét lệnh mới.`, "success");
            }
        }
    }

    // Nếu trạng thái bảo vệ đang kích hoạt -> Chặn đứng không cho chạy xuống logic quét coin mở lệnh mới bên dưới
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

APP.listen(9001);
