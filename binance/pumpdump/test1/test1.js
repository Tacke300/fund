import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';
import { checkEntryCondition } from './dieukien.js';

const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1%", 
    minVol: 7, 
    posTP: 10, 
    posSL: 10.0, 
    posdca: 3,        
    maxDCA: 5,        
    diangucvol: 15 
};

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
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex')}` });
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

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol];
            addBotLog(`🔄 Unban Blacklist: ${symbol} (Hết hạn phạt giao dịch)`, "success");
        }
    }
}, 1000);

async function initBotCrossMargin() {
    if (!status.exchangeInfo) return;
    const symbols = Object.keys(status.exchangeInfo);
    addBotLog(`⚙️ Đồng bộ hóa chế độ CROSS tự động cho ${symbols.length} cặp...`);
    for (const symbol of symbols) {
        await setCrossMargin(symbol);
        await new Promise(r => setTimeout(r, 50));
    }
    addBotLog(`✅ Đồng bộ CROSS toàn danh mục hoàn tất.`);
}

async function setCrossMargin(symbol) {
    try {
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' });
    } catch (error) {
        // -4046 nghĩa là tài khoản đã ở chế độ Cross sẵn
    }
}

// --- GIÁM SÁT GIÁ, TÍNH TOÁN LÃI XU HƯỚNG VÀ CỨU THƯƠNG SỚM ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot Dừng. Xóa lệnh TP/SL đang treo...`, "warn");
            for (let [key, b] of botActivePositions) {
                try {
                    const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of orders.filter(o => o.positionSide === b.side)) {
                        await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                    }
                } catch (err) {}
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
                
                // MULTIPLIER ĐẢM BẢO SÓNG ĐI ĐÚNG HƯỚNG LÃI THÌ BIẾN ĐỘNG MỚI TĂNG (DCA DƯƠNG)
                const directionMultiplier = b.side === 'LONG' ? 1 : -1;
                b.priceDev = ((markP - b.firstEntry) / b.firstEntry) * 100 * directionMultiplier;

                if (b.currentQty !== currentQty) { 
                    b.currentQty = currentQty; 
                    b.hitTime = null; 
                }

                // KHỐI CỨU THƯƠNG SỚM: BẬT NGAY TỪ LẦN DCA ĐẦU TIÊN (b.dcaCount > 0)
                if (b.dcaCount > 0) {
                    const simpleAvgEntry = b.dcaHistory.reduce((sum, val) => sum + val, 0) / b.dcaHistory.length;
                    let isViolation = false;

                    // Nếu nhồi lệnh dương mà giá đột ngột quay đầu quét thủng giá trung bình cộng (bị âm ngược)
                    if (b.side === 'LONG' && markP < simpleAvgEntry) isViolation = true;
                    if (b.side === 'SHORT' && markP > simpleAvgEntry) isViolation = true;

                    if (isViolation) {
                        addBotLog(`🛡️ [CỨU THƯƠNG KÍCH HOẠT] ${b.symbol} | Quay đầu chạm Avg Entry: ${simpleAvgEntry} | Ép đóng MARKET bảo toàn vốn!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                        
                        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
                            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                        }
                        botActivePositions.delete(key);
                        continue;
                    }
                }

                // Kiểm tra treo lệnh chốt sàn ngoài 30 giây
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ Treo lệnh sàn quá 30s tại ${b.symbol}. Ép lệnh MARKET thủ công!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { 
                    b.hitTime = null; 
                }

                // XỬ LÝ NHỒI THUẬN XU HƯỚNG (DCA DƯƠNG)
                const nextDcaLevel = b.dcaCount + 1;
                const targetDcaThreshold = botSettings.posdca * nextDcaLevel; // Quét khoảng cách tịnh tiến dần lên công thức lãi

                if (b.priceDev >= targetDcaThreshold && nextDcaLevel <= botSettings.maxDCA && !isProcessingDCA.has(b.symbol)) {
                    addBotLog(`🚀 [SÓNG CÙNG CHIỀU] ${b.symbol} lãi đạt +${b.priceDev.toFixed(2)}%. Khởi chạy nhồi vị thế lần ${nextDcaLevel}!`, "success");
                    
                    openPosition(b.symbol, { 
                        ...b, 
                        dcaCount: nextDcaLevel, 
                        margin: b.firstMargin, // Nhồi thêm volume bằng volume gốc của lệnh 1
                        dcaHistory: [...b.dcaHistory, markP] 
                    }, b.side, 0);
                }

            } else {
                // Xử lý dọn dẹp bộ nhớ lệnh khi vị thế đã biến mất (Đã cắn TP hoặc SL trên sàn)
                if (isProcessingDCA.has(b.symbol)) continue;
                await new Promise(r => setTimeout(r, 500));

                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 12 });
                const closedOrder = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

                let reasonOfClose = "SÀN / ĐÓNG TAY"; 
                if (closedOrder) {
                    reasonOfClose = closedOrder.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";
                }

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 30000));
                
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
                const netPnl = totalR - (totalV * 0.0004);

                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                if (netPnl > 0) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000); // Thắng thì cho vào hộp đen nghỉ 15p
                }

                const logText = netPnl > 0 ? "💰 [CHỐT LỜI XU HƯỚNG]" : "📉 [DỪNG LỖ VỊ THẾ]";
                addBotLog(`${logText} ${b.symbol} | ${b.side} | Đã nhồi: ${b.dcaCount} Lần | Giá Đóng: ${avgClosePrice.toFixed(4)} | PnL ròng: ${netPnl.toFixed(2)}$ | Kiểu: ${reasonOfClose}`, netPnl > 0 ? "success" : "error");
            }
        }
    } catch (e) { console.error("Monitor Error:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- LUỒNG KHỞI TẠO VÀ TÍNH KHỐI LƯỢNG LỆNH ---
async function openPosition(symbol, dcaData = null, forcedSide = null, vol = 0) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol); 
    
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCA = dcaData !== null;

    try {
        const info = status.exchangeInfo[symbol];
        if (!info) throw new Error(`Thiếu dữ liệu sàn cho cặp ${symbol}`);
        
        const acc = await binancePrivate('/fapi/v2/account');
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);

        let qty = 0;
        let margin = 0;

        if (isDCA) {
            margin = dcaData.margin;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.invValue.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.invValue) / 100) 
                : parseFloat(botSettings.invValue);

            const desiredQty = (margin * info.maxLeverage) / currentPrice;
            const minQtyRequired = 5.5 / currentPrice; 
            qty = Math.ceil(Math.max(desiredQty, minQtyRequired) / info.stepSize) * info.stepSize;
        }

        if (qty < info.stepSize) qty = info.stepSize;
        const actualMarginUsed = (qty * currentPrice) / info.maxLeverage;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1200));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const currentQty = Math.abs(parseFloat(p.positionAmt));
                const firstE = isDCA ? dcaData.firstEntry : entry;
                const dcaCount = isDCA ? dcaData.dcaCount : 0;
                const updatedDcaHistory = isDCA ? [...dcaData.dcaHistory, entry] : [entry];

                const dir = (side === 'LONG') ? 1 : -1;
                
                // Công thức tính toán Target TP dựa trên toàn bộ khối lượng sau nhồi
                const tp = entry * (1 + (dir * (botSettings.posTP / 100)));
                const sl = firstE * (1 - (dir * (botSettings.posSL / 100))); // Chặn SL cứng theo điểm entry xuất phát

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: isDCA ? dcaData.firstMargin : actualMarginUsed, 
                    currentMargin: actualMarginUsed, currentQty, dcaHistory: updatedDcaHistory, 
                    pnl: 0, priceDev: 0, hitTime: null
                });

                addBotLog(`📡 [${isDCA ? `NHỒI_DCA_${dcaCount}` : 'MỞ_LỆNH'}] ${symbol} | ${side} | Cược: ${actualMarginUsed.toFixed(2)}$ | Entry Mới: ${entry} | TP Sàn: ${sync.tp.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { 
        addBotLog(`❌ Lỗi luồng đặt vị thế ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(symbol), 2000); 
    }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        await new Promise(r => setTimeout(r, 400));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    const visualBlacklist = {};
    const now = Date.now();
    for (const s in status.blackList) {
        const remainingTime = status.blackList[s] - now;
        if (remainingTime > 0) {
            visualBlacklist[s] = `${Math.floor(remainingTime / 60000)}m ${Math.floor((remainingTime % 60000) / 1000)}s`;
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
    addBotLog(`⚙️ Hệ thống đã lưu thay đổi thông số từ UI.`, "success");
    res.json({ success: true }); 
});

// Thao tác quét nhận tín hiệu mở từ cổng nội bộ 9000
setInterval(() => {
    if (!botSettings.isRunning || !status.isReady || isMarginProtected) return;
    if (botActivePositions.size >= botSettings.maxPositions) return;

    const targetSignals = status.candidatesList.filter(c => !status.blackList[c.symbol] && !status.permanentBlacklist[c.symbol]);
    for (const signal of targetSignals) {
        if (botActivePositions.has(`${signal.symbol}_SHORT`) || botActivePositions.has(`${signal.symbol}_LONG`)) continue;
        
        const action = checkEntryCondition(signal, botSettings.minVol);
        if (action === 'SHORT' || action === 'LONG') {
            addBotLog(`🎯 Nhận tín hiệu cổng chiến thuật: Khởi chạy ${action} cho mã ${signal.symbol}`);
            openPosition(signal.symbol, null, action, parseFloat(signal.c1));
            break; 
        }
    }
}, 2000);

async function init() {
    try {
        const ipRes = await axios.get('https://api4.ipify.org?format=json', { timeout: 8000 }).catch(() => ({ data: { ip: "127.0.0.1" } }));
        currentBotIP = ipRes.data.ip; 
        addBotLog(`🌍 IP KHỞI CHẠY: ${currentBotIP}`, "success"); 
        
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
        status.exchangeInfo = temp; 
        status.isReady = true; 

        await initBotCrossMargin();
        priceMonitor();
        addBotLog(`🚀 Hệ thống giám sát vận hành thành công.`);
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
                addBotLog(`🚨 [CẢNH BÁO MARGIN] Đóng băng tìm kiếm lệnh mới. Khả dụng: ${availPercent.toFixed(1)}%`, "error");
            } else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                isMarginProtected = false;
                addBotLog(`🔄 [HỒI PHỤC MARGIN] Kích hoạt tìm lệnh mới trở lại. Khả dụng: ${availPercent.toFixed(1)}%`, "success");
            }
        }
    }
}, 2000);

APP.listen(80, () => console.log('🌐 Web Dashboard server running on port 80'));
