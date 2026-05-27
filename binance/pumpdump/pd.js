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
const MAX_DCA_LEVEL = 2;            
const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    
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
        recvWindow: 60000, 
        adjustForTimeDifference: true 
    } 
});

// =========================================================================
// MẢNG 3: QUẢN LÝ BIẾN TRẠNG THÁI TOÀN CỤC (GLOBAL STATE)
// =========================================================================
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
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

        const pRisk = await binancePrivate('/fapi/v2/positionRisk').catch(() => null);
        if (!pRisk) return setTimeout(priceMonitor, 1000);
        
        for (let [key, b] of botActivePositions) {
            const realP = pRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
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
                        addBotLog(`⚠️ Treo lệnh >30s tại ${b.symbol}. Ép đóng MARKET!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side }).catch(()=>{});
                    }
                } else { b.hitTime = null; }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;

                await new Promise(r => setTimeout(r, 1000));

                const allOrders = await binancePrivate('/fapi/v1/allOrders', 'GET', { symbol: b.symbol, limit: 10 }).catch(() => []);
                const closedById = allOrders.find(o => o.positionSide === b.side && o.status === 'FILLED' && (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET'));

                let reasonOfClose = "MANUAL"; 
                if (closedById) {
                    reasonOfClose = closedById.type === 'STOP_MARKET' ? "SL_MARKET" : "TP_MARKET";
                }

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 }).catch(() => []);
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

                // FIX CHU KỲ TRADING CHUẨN:
                if (b.isFinalLong || netPnl > 0) {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                }

                const logType = netPnl > 0 ? "💰 [CHỐT LỜI]" : "📉 [CẮT LỖ]";
                const logStatus = netPnl > 0 ? "success" : "error";
                addBotLog(`${logType} ${b.symbol} | ${b.side} | DCA: ${b.dcaCount}/${botSettings.maxDCA} | ClosePrice: ${avgClosePrice.toFixed(5)} | PnL: ${netPnl.toFixed(4)}$ | Type: ${reasonOfClose}`, logStatus);

                if (netPnl < 0 && b.side === 'SHORT') {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
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

                // FIX PERCENT_PRICE: Thử sai nâng hạ biên độ khi tạo lệnh điều kiện rào TP/SL sàn Binance
                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, currentMargin: actualMarginUsed, 
                    currentQty: qty, virtualTotalQty: qty, virtualTotalCost: qty * entry, 
                    dcaHistory: dcaHistory, pnl: 0, priceDev: 0, hitTime: null,
                    isFinalLong: dcaData ? dcaData.isFinalLong : false 
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

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    let currentTp = tpPrice;
    let currentSl = slPrice;
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId }).catch(()=>{});
    } catch(e){}

    for (let i = 0; i < 3; i++) {
        try {
            await new Promise(r => setTimeout(r, 500));
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: currentTp.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: currentSl.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
            return { tp: currentTp, sl: currentSl }; 
        } catch (e) {
            if (e.message.includes('-4131') || e.message.includes('PERCENT_PRICE')) {
                if (side === 'SHORT') {
                    currentTp = currentTp * 0.995; 
                    currentSl = currentSl * 1.005; 
                } else {
                    currentTp = currentTp * 1.005; 
                    currentSl = currentSl * 0.995;
                }
            } else { break; }
        }
    }
    return { tp: tpPrice, sl: slPrice };
}

// =========================================================================
// MẢNG 7: KHỞI TẠO SERVER APP API ROUTE (ĐỒNG BỘ GIAO DIỆN WEB HTML)
// =========================================================================
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

// SỬA ĐỔI CHÍNH TẠI ĐÂY: Bot tự tính toán chuyển mốc Blacklist thô thành chuỗi đếm ngược trực quan MM:SS gửi lên HTML UI
APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    
    const formattedBlacklist = {};
    const now = Date.now();
    for (const symbol in status.blackList) {
        const timeLeft = status.blackList[symbol] - now;
        if (timeLeft > 0) {
            const minutes = Math.floor(timeLeft / 60000);
            const seconds = Math.floor((timeLeft % 60000) / 1000);
            // Ép chuỗi hiển thị đúng chuẩn đồng hồ đếm ngược dạng trực quan (Ví dụ: 14:05)
            formattedBlacklist[symbol] = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: {
            ...status,
            blackList: formattedBlacklist // Ghi đè truyền cấu trúc dạng MM:SS lên thẳng HTML hiển thị
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

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// =========================================================================
// MẢNG 9: VÒNG LẶP KIỂM TRA MARGIN PROTECT VÀ QUÉT LỆNH ĐA CẶP SONG SONG
// =========================================================================
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
    if (botActivePositions.size >= botSettings.maxPositions) return;

    // FIX CHẶN NUỐT SỐ 0: Kiểm tra chặt chẽ điều kiện để không bỏ lỡ tín hiệu
    const validCandidates = status.candidatesList.filter(c => {
        const matchM1 = c.c1 !== undefined && c.c1 !== null && Math.abs(c.c1) >= botSettings.minVol; 
        const matchM5 = c.c2 !== undefined && c.c2 !== null && Math.abs(c.c2) >= botSettings.minVol; 

        return (matchM1 || matchM5) && 
               !status.blackList[c.symbol] && 
               !status.permanentBlacklist[c.symbol] && 
               !botActivePositions.has(`${c.symbol}_SHORT`) &&
               !isProcessingDCA.has(c.symbol); 
    });

    for (const can of validCandidates) {
        if (botActivePositions.size >= botSettings.maxPositions) break;

        const volM1 = (can.c1 !== undefined && can.c1 !== null) ? `${can.c1}%` : 'N/A';
        const volM5 = (can.c2 !== undefined && can.c2 !== null) ? `${can.c2}%` : 'N/A';
        const volM15 = (can.c3 !== undefined && can.c3 !== null) ? `${can.c3}%` : 'N/A';

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
