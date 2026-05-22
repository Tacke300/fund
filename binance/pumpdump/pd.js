import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const MAX_DCA_LEVEL = 3;
const MARGIN_PROTECT_LIMIT = 50; 
const MARGIN_RECOVER_LIMIT = 60; 
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 10000, adjustForTimeDifference: true } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(), isProcessingDCA = new Set();
let isMonitorRunning = false, timestampOffset = 0, isMarginProtected = false;

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const query = new URLSearchParams({ ...data, timestamp: Date.now() + timestampOffset, recvWindow: 10000 }).toString();
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        return (await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` })).data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            timestampOffset = (await axios.get('https://fapi.binance.com/fapi/v1/time')).data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

// --- QUẢN LÝ BLACKLIST ĐỘC LẬP ---
setInterval(() => {
    const now = Date.now();
    for (const s in status.blackList) {
        if (now > status.blackList[s]) { delete status.blackList[s]; addBotLog(`🔄 Giải phóng khỏi Blacklist: ${s}`, "success"); }
    }
}, 5000);

// --- PRICE MONITOR & SỬA BẪY LOG ĐÓNG LỆNH ---
async function priceMonitor() {
    if (!status.isReady || isMonitorRunning) return setTimeout(priceMonitor, 1000);
    isMonitorRunning = true;
    try {
        if (!botSettings.isRunning && botActivePositions.size > 0) {
            addBotLog(`🛑 Bot STOP. Tiến hành hủy toàn bộ TP/SL treo...`, "warn");
            for (let [key, b] of botActivePositions) {
                const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                for (const o of orders.filter(o => o.positionSide === b.side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
            }
            botActivePositions.clear(); isProcessingDCA.clear();
        }

        if (!botSettings.isRunning) { isMonitorRunning = false; return setTimeout(priceMonitor, 1000); }

        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

                if (b.currentQty !== currentQty) { b.currentQty = currentQty; b.hitTime = null; }

                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ ${b.symbol} treo >30s. Ép đóng MARKET khẩn cấp!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                if (isProcessingDCA.has(b.symbol)) continue;
                await new Promise(r => setTimeout(r, 800));

                try {
                    const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
                    for (const o of openOrders.filter(o => o.positionSide === b.side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId });
                } catch (e) {}

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 6 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 30000));
                
                let totalR = 0, totalV = 0, lastPrice = b.entryPrice;
                recent.forEach(t => { totalR += parseFloat(t.realizedPnl); totalV += (parseFloat(t.price) * parseFloat(t.qty)); lastPrice = parseFloat(t.price); });
                const netPnl = totalR - (totalV * 0.0004);

                // Khắc phục bẫy sai nhãn: So sánh khoảng cách toán học giữa giá khớp thực tế và mốc cấu hình
                let reason = "ĐÓNG TAY (USER_MANUAL)";
                if (recent.length > 0) {
                    if (Math.abs(lastPrice - b.sl) / b.sl < 0.012) reason = "DÍNH CẮT LỖ (STOP_LOSS_MARKET)";
                    else if (Math.abs(lastPrice - b.tp) / b.tp < 0.012) reason = "CẮT LỜI THÀNH CÔNG (TAKE_PROFIT_MARKET)";
                }

                botActivePositions.delete(key);
                status.botClosedCount++; status.botPnLClosed += netPnl;
                status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);

                console.log(`\n📦 [CHI TIẾT ĐÓNG LỆNH]\n- Cặp Coin: ${b.symbol} | Hướng: ${b.side}\n- Nguyên nhân: ${reason}\n- Số lần đã DCA: ${b.dcaCount}/${botSettings.maxDCA}\n- Giá vào trung bình ảo: ${b.virtualTotalCost > 0 ? (b.virtualTotalCost / b.virtualTotalQty).toFixed(5) : b.entryPrice}\n- Giá khớp đóng thực tế: ${lastPrice}\n- Mức độ trượt giá: ${reason === "DÍNH CẮT LỖ (STOP_LOSS_MARKET)" ? Math.abs(((lastPrice - b.sl) / b.sl) * 100).toFixed(2) + '%' : 'Không dính'}\n- Tổng PnL ròng (đã trừ phí): ${netPnl.toFixed(4)}$\n`);
                addBotLog(`📦 Đóng ${b.symbol} | PnL: ${netPnl.toFixed(2)}$ | Lý do: ${reason}`, netPnl > 0 ? "success" : "error");

                if (netPnl < 0 && b.side === 'SHORT' && reason === "DÍNH CẮT LỖ (STOP_LOSS_MARKET)") {
                    const jump = b.dcaCount + 1;
                    if (jump <= botSettings.maxDCA) {
                        openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    } else {
                        openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                    }
                }
            }
        }
    } catch (e) { console.error("Monitor Err:", e.message); }
    isMonitorRunning = false;
    setTimeout(priceMonitor, 1000);
}

// --- KHỞI TẠO VÀ DCA VỊ THẾ ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const isDCA = dcaData !== null;
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        const acc = await binancePrivate('/fapi/v2/account');
        
        let margin = isDCA ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const curPrice = parseFloat(ticker.data.price);

        let qty = 0, isForcedMin = false;
        if (isDCA) {
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / curPrice) / info.stepSize) * info.stepSize;
        } else {
            const desiredQty = (margin * info.maxLeverage) / curPrice;
            const minQty = 5.05 / curPrice;
            if (minQty > desiredQty) isForcedMin = true;
            qty = Math.ceil(Math.max(desiredQty, minQty) / info.stepSize) * info.stepSize;
            if (qty < info.stepSize) qty = info.stepSize;
        }

        const actualMargin = (qty * curPrice) / info.maxLeverage;
        await exchange.setLeverage(info.maxLeverage, symbol);

        addBotLog(`📡 [KHỞI TẠO VỊ THẾ] ${symbol} | Lồng: ${isDCA ? (dcaData.isFinalLong ? 'LONG CỨU' : 'DCA ' + dcaData.dcaCount) : 'MỞ MỚI'} | Vol: ${(qty * curPrice).toFixed(2)}$ | Ép Min: ${isForcedMin ? 'BẬT' : 'TẮT'}`);

        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            if (p) {
                const entry = parseFloat(p.entryPrice), firstE = dcaData ? dcaData.firstEntry : entry, dcaCount = dcaData ? dcaData.dcaCount : 0;
                let vAvg = entry, vQty = qty, vCost = qty * entry;

                if (isDCA) { vQty = dcaData.virtualTotalQty + qty; vCost = dcaData.virtualTotalCost + (qty * entry); vAvg = vCost / vQty; }

                let tp = side === 'LONG' ? entry * 1.10 : vAvg * (1 - botSettings.posTP / 100);
                let sl = side === 'LONG' ? entry * 0.90 : firstE + (firstE * (botSettings.posSL * (dcaCount + 1)) / 100);

                const sync = await syncTPSL(symbol, side, info, tp, sl);
                
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, dcaCount, leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: isDCA ? dcaData.firstMargin : actualMargin, currentMargin: actualMargin, currentQty: qty, virtualTotalQty: vQty, virtualTotalCost: vCost, 
                    dcaHistory: isDCA ? [...dcaData.dcaHistory, entry] : [entry], pnl: 0, priceDev: 0, hitTime: null 
                });
                
                console.log(`\n🎯 [THÔNG SỐ VỊ THẾ HOẠT ĐỘNG]\n- Cặp: ${symbol} | Entry: ${entry} | Mốc TP: ${sync.tp.toFixed(info.pricePrecision)} | Mốc SL: ${sync.sl.toFixed(info.pricePrecision)}\n- Tích lũy ảo: Vol=${(vQty * curPrice).toFixed(2)}$, EntryTB=${vAvg.toFixed(5)}\n`);
            }
        }
    } catch (e) { addBotLog(`❌ Thất bại mở vị thế ${symbol}: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
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
    } catch (e) { return { tp: tpPrice, sl: slPrice }; }
}

// --- API LAYER & CONFIG ---
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet: acc ? { totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) } : { availableBalance: "ERR" } });
});

APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; botSettings.maxDCA = parseInt(botSettings.maxDCA); botSettings.maxPositions = parseInt(botSettings.maxPositions); botSettings.minVol = parseFloat(botSettings.minVol); res.json({ success: true }); });

async function init() {
    try {
        timestampOffset = (await axios.get('https://fapi.binance.com/fapi/v1/time')).data.serverTime - Date.now();
        await exchange.loadMarkets();
        const info = (await binanceApi.get('/fapi/v1/exchangeInfo')).data;
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        
        info.symbols.forEach(s => {
            const maxLev = brk.find(x => x.symbol === s.symbol)?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { status.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; status.isReady = true; priceMonitor();
        addBotLog(`🚀 Hệ thống khởi tạo môi trường hoàn tất. Sẵn sàng quét.`);
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// --- VÒNG LẶP KIỂM TRA MARGIN PROTECT & QUÉT CANDIDATES ---
setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return;

    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availUsdt = parseFloat(acc.availableBalance || 0);
        if (totalWallet > 0) {
            const availPercent = (availUsdt / totalWallet) * 100;
            if (!isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
                isMarginProtected = true;
                addBotLog(`🚨 [CẢNH BÁO KÝ QUỸ] Đóng băng quét mới. Khả dụng: ${availPercent.toFixed(1)}%`, "error");
            } else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
                isMarginProtected = false;
                addBotLog(`🛡️ [HỒI PHỤC KÝ QUỸ] Giải phóng quét lệnh. Khả dụng: ${availPercent.toFixed(1)}%`, "success");
            }
        }
    }

    if (isMarginProtected) return;

    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => Math.abs(c.c1) >= botSettings.minVol && !status.blackList[c.symbol] && !status.permanentBlacklist[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
