import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 3; 

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

// --- MONITOR GIÁM SÁT VÀ KÍCH HOẠT NHẢY CẤP KHI BỊ QUÉT SL VẬT LÝ ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
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

                // Chốt chặn khẩn cấp đề phòng sàn bị lag lệnh TP/SL vật lý (>30 giây)
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ ${b.symbol} Treo lệnh vật lý >30s. Bấm Market đóng khẩn cấp!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                // LỆNH CŨ ĐÃ BỊ QUÉT SẠCH KHỎI SÀN (Vị thế về 0) -> TÍNH TOÁN CẤP TIẾP THEO
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 20000));
                let totalR = 0, totalV = 0;
                recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); });
                const fee = totalV * 0.001; const netPnl = totalR - fee;

                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += netPnl;

                // Nếu khớp lệnh chốt lời (NetPnl dương) hoặc đang ở vị thế quay xe LONG
                if (netPnl > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 BOT CHỐT LỜI THÀNH CÔNG ${b.symbol} | Net PnL: ${netPnl.toFixed(2)}$`);
                } else {
                    // Nếu dính SL vật lý (Thua lỗ) -> Kích hoạt lệnh DCA mới dựa trên bộ nhớ lịch sử
                    const nextDcaCount = b.dcaCount + 1;
                    if (nextDcaCount <= botSettings.maxDCA) {
                        addBotLog(`⚠️ ${b.symbol} Bị quét SL vật lý. Tiến hành kích hoạt DCA Cấp ${nextDcaCount}`);
                        // Kế thừa toàn bộ bộ nhớ cũ sang lệnh mới: dcaCount, virtualTotalQty, virtualTotalCost, firstEntry
                        openPosition(b.symbol, { 
                            ...b, 
                            dcaCount: nextDcaCount, 
                            margin: b.firstMargin * (nextDcaCount + 1) 
                        });
                    } else {
                        addBotLog(`🚨 ${b.symbol} Vượt giới hạn Max DCA (${botSettings.maxDCA}). CHUYỂN HƯỚNG QUAY XE LONG!`, "warn");
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- HÀM MỞ VỊ THẾ MỚI TOANH HOẶC MỞ LỆNH DCA SAU KHI LỆNH CŨ BỊ QUÉT ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 600));
        const acc = await binancePrivate('/fapi/v2/account');
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
        
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        let qty = Math.ceil(((margin * info.maxLeverage) / parseFloat(ticker.data.price)) / info.stepSize) * info.stepSize;
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1200));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const actualMarketPrice = parseFloat(p.entryPrice); // Giá khớp thực tế của riêng lệnh mới này
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                const firstE = dcaData ? dcaData.firstEntry : actualMarketPrice;
                
                let virtualAvgEntry = actualMarketPrice;
                let currentAccumulatedQty = qty;
                let currentAccumulatedCost = qty * actualMarketPrice;

                // THUẬT TOÁN TỰ TÍNH TOÁN GIÁ TRUNG BÌNH GIẢ LẬP DỰA TRÊN LỊCH SỬ KHỐI LƯỢNG ĐÃ QUA
                if (dcaData) {
                    currentAccumulatedQty = dcaData.virtualTotalQty + qty;
                    currentAccumulatedCost = dcaData.virtualTotalCost + (qty * actualMarketPrice);
                    virtualAvgEntry = currentAccumulatedCost / currentAccumulatedQty; // Giá trung bình giả lập tích lũy
                }

                let tp = 0, sl = 0;
                if (side === 'LONG') {
                    tp = actualMarketPrice * 1.10;
                    sl = actualMarketPrice * 0.90;
                } else {
                    // 1. Lệnh TP tính chuẩn xác từ GIÁ TRUNG BÌNH GIẢ LẬP TÍCH LŨY
                    tp = virtualAvgEntry * (1 - botSettings.posTP / 100);
                    
                    // 2. Lệnh SL tịnh tiến tăng dần cố định +10%, +20%, +30% từ GIÁ ENTRY ĐẦU TIÊN
                    sl = firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);
                }
                
                // Gửi cặp TP/SL vật lý mới toanh lên sàn quản lý
                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: actualMarketPrice, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, currentMargin: margin, 
                    currentQty: qty,
                    virtualTotalQty: currentAccumulatedQty,   // Lưu bộ nhớ tổng khối lượng tích lũy
                    virtualTotalCost: currentAccumulatedCost, // Lưu bộ nhớ tổng chi phí tích lũy
                    pnl: 0, priceDev: 0, hitTime: null 
                });
                
                addBotLog(`✅ Khớp Cấp ${dcaCount} ${symbol} | Giá Khớp: ${actualMarketPrice} | Giá TB Giả Lập: ${virtualAvgEntry.toFixed(info.pricePrecision)} | Mốc SL Sàn: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi Mở lệnh/DCA: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 1500); }
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

async function init() {
    try {
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
        addBotLog(`🚀 Khởi động hoàn tất. Đã khóa vĩnh viễn các cặp coin có Max leverage < x20.`);
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
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
