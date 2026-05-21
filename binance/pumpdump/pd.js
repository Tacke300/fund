import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// ==========================================
// CẤU HÌNH NHANH
// ==========================================
const MAX_DCA_LEVEL = 3; 
// ==========================================

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
let botActivePositions = new Map(); // DANH SÁCH DUY NHẤT BOT QUẢN LÝ
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

// --- MONITOR QUẢN LÝ LỆNH VÀ XỬ LÝ EVENT STOP/ĐÓNG TAY ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        // CHỐT CHẶN 1: BẤM STOP TRÊN UI -> BUÔNG LỆNH KHÔNG QUẢN LÝ NỮA
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
                        addBotLog(`⚠️ ${b.symbol} treo >30s. Đóng khẩn cấp!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                // CHỐT CHẶN 2: PHÁT HIỆN VỊ THẾ KHÔNG CÒN TRÊN SÀN
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 30000));
                
                if (recent.length === 0) {
                    addBotLog(`⚠️ Vị thế ${b.symbol} biến mất không rõ nguyên do (Nghi ngờ đóng tay bên ngoài). Hủy theo dõi!`, "warn");
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
                    addBotLog(`💰 BOT CHỐT ${b.symbol} | Net: ${netPnl.toFixed(2)}$`);
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

// --- CÁC HÀM API & KHỞI TẠO ---
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    
    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: Array.from(botActivePositions.values()).reduce((s, p) => s + p.pnl, 0).toFixed(2) 
        } : { totalWalletBalance: "0.00", availableBalance: "ERR", totalUnrealizedProfit: "0.00" } 
    });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    botSettings.maxDCA = parseInt(botSettings.maxDCA);
    botSettings.maxPositions = parseInt(botSettings.maxPositions);
    botSettings.minVol = parseFloat(botSettings.minVol);
    addBotLog(`⚙️ Cấu hình mới: Run=${botSettings.isRunning}, MaxDCA=${botSettings.maxDCA}`, "success");
    res.json({ success: true }); 
});

async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        await new Promise(r => setTimeout(r, 1000));
        const acc = await binancePrivate('/fapi/v2/account');
        const availableUsdt = acc ? parseFloat(acc.availableBalance || 0) : 0;
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (availableUsdt * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        let qty = Math.ceil(((margin * info.maxLeverage) / parseFloat(ticker.data.price)) / info.stepSize) * info.stepSize;
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
                    firstMargin: dcaData ? dcaData.firstMargin : margin, currentMargin: margin, 
                    currentQty: qty,
                    virtualTotalQty: currentAccumulatedQty,   
                    virtualTotalCost: currentAccumulatedCost, 
                    dcaHistory: dcaData ? [...dcaData.dcaHistory, entry] : [entry], 
                    pnl: 0, priceDev: 0, hitTime: null 
                });
                addBotLog(`✅ BOT Mở lệnh/DCA ${symbol} (Cấp ${dcaCount}) | Giá TB Giả Lập: ${virtualAvgEntry.toFixed(info.pricePrecision)} | Mốc SL: ${sync.sl.toFixed(info.pricePrecision)}`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi Bot: ${e.message}`, "error"); }
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
    } catch (e) { return { tp: 0, sl: 0 }; }
}

async function init() {
    try {
        const ipRes = await axios.get('https://api.ipify.org?format=json').catch(() => ({ data: { ip: "Lỗi" } }));
        console.log(`\n🌍 Bạn đang truy cập = IP: ${ipRes.data.ip}`);
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
        addBotLog(`🚀 Bot Ready (IPv4: ${ipRes.data.ip}) | Đã chặn vĩnh viễn các cặp coin có Max Leverage < x20`);
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

    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) {
            delete status.blackList[symbol]; 
        }
    }

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
