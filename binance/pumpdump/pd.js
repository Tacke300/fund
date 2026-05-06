import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình kết nối
const RECV_WINDOW = 5000;
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: RECV_WINDOW } 
});

// Cấu hình Bot
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: {}, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, publicIP: "Đang kiểm tra..." };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();
let lastLogMsg = "";

function addBotLog(msg, type = 'info') {
    if (msg === lastLogMsg) return;
    lastLogMsg = msg;
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Hệ thống lấy IP & Sync Time
async function checkIP() {
    try {
        const res = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
        status.publicIP = res.data.ip;
        addBotLog(`🌐 VPS IPv4: ${status.publicIP}`, "success");
    } catch (e) { status.publicIP = "Lỗi IP"; }
}

async function syncTime() { 
    try { 
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); 
        timestampOffset = res.data.serverTime - Date.now(); 
    } catch (e) { addBotLog(`❌ Lỗi Sync Time`, "error"); } 
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: RECV_WINDOW }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

// QUY TRÌNH DỌN DẸP LỆNH CHỜ
async function hardClearOrders(symbol) {
    try {
        addBotLog(`🗑️ [${symbol}] Xóa tất cả lệnh chờ cũ...`);
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 3000));
        
        const remain = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        if (remain.length > 0) {
            addBotLog(`⚠️ [${symbol}] Còn sót ${remain.length} lệnh, xóa thủ công từng ID...`);
            for (const o of remain) {
                await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
            }
            await new Promise(r => setTimeout(r, 2000));
        }
        return true;
    } catch (e) { return true; }
}

// KIỂM TRA LỆNH CHỜ TRÊN SÀN CÓ KHỚP VỚI BOT KHÔNG
async function verifyTPSL(symbol, side, targetTP, targetSL) {
    try {
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        const myOrders = openOrders.filter(o => o.positionSide === side);
        let tpOk = false, slOk = false;

        myOrders.forEach(o => {
            const stopPrice = parseFloat(o.stopPrice);
            if (o.type === 'TAKE_PROFIT_MARKET' && Math.abs(stopPrice - targetTP) < 0.0000001) tpOk = true;
            if (o.type === 'STOP_MARKET' && Math.abs(stopPrice - targetSL) < 0.0000001) slOk = true;
        });
        return (tpOk && slOk);
    } catch (e) { return false; }
}

// CÀI ĐẶT TP/SL VỚI CƠ CHẾ XÁC MINH 2 LỚP
async function syncTPSL(symbol, side, entry, info, customTP = null, customSL = null) {
    const isShort = (side === 'SHORT');
    const tpPrice = Number((entry * (isShort ? (1 - (customTP || botSettings.posTP) / 100) : (1 + (customTP || 10) / 100))).toFixed(info.pricePrecision));
    const slPrice = Number((entry * (isShort ? (1 + (customSL || botSettings.posSL) / 100) : (1 - (customSL || 10) / 100))).toFixed(info.pricePrecision));
    const sideClose = isShort ? 'buy' : 'sell';

    let retry = 0;
    while (retry < 2) {
        await hardClearOrders(symbol);
        addBotLog(`⏳ [${symbol}] Đang đặt TP/SL mới (Lần ${retry + 1})...`);
        await new Promise(r => setTimeout(r, 3000));

        try {
            await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: 'true' });
            await new Promise(r => setTimeout(r, 1000));
            await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: slPrice, closePosition: 'true' });
            
            await new Promise(r => setTimeout(r, 3000));
            const isOk = await verifyTPSL(symbol, side, tpPrice, slPrice);
            if (isOk) {
                addBotLog(`✅ [${symbol}] Lệnh chờ TP/SL đã khớp chính xác trên sàn.`, "success");
                return { tp: tpPrice, sl: slPrice };
            }
        } catch (e) { addBotLog(`❌ Lỗi cài TP/SL ${symbol}: ${e.message}`, "error"); }
        retry++;
    }
    addBotLog(`🚨 [${symbol}] KHÔNG THỂ CÀI LỆNH CHỜ SAU 2 LẦN. Chế độ quét giá khẩn cấp đã kích hoạt!`, "warning");
    return { tp: tpPrice, sl: slPrice };
}

// MỞ LỆNH PHÒNG HỘ LONG X50
async function openHedgeLong(symbol, firstMargin, info) {
    try {
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        const hedgeMargin = firstMargin * 50;
        let qtyNum = Math.ceil((hedgeMargin * info.maxLeverage / currentPrice) / info.stepSize) * info.stepSize;

        addBotLog(`🛡️ [${symbol}] GIÁ TĂNG QUÁ MẠNH! ĐANG MỞ LONG PHÒNG HỘ X50 VỐN...`);
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'buy', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'LONG' });

        if (order) {
            await new Promise(r => setTimeout(r, 3000));
            const sync = await syncTPSL(symbol, 'LONG', currentPrice, info, 10, 10);
            addBotLog(`⚠️ ĐÃ MỞ HEDGE LONG: ${symbol} | Margin: $${hedgeMargin.toFixed(2)} | Entry: ${currentPrice} | TP: ${sync.tp} | SL: ${sync.sl}`, "warning");
        }
    } catch (e) { addBotLog(`🚨 Lỗi Hedge ${symbol}: ${e.message}`, "error"); }
}

// MỞ LỆNH HOẶC DCA
async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        let currentPos = botActivePositions.get(posKey);
        
        // DCA 1.0: Sử dụng đúng số vốn ban đầu (Fixed Margin)
        let marginToUse = isDCA ? currentPos.firstMargin : (botSettings.invValue.toString().includes('%') ? 
            (await binancePrivate('/fapi/v2/account')).availableBalance * parseFloat(botSettings.invValue) / 100 : parseFloat(botSettings.invValue));

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 6.5) qtyNum = (6.5 / currentPrice);

        addBotLog(`🚀 [${symbol}] ${isDCA ? `Đang DCA lần ${currentPos.dcaCount + 1}` : 'Đang mở lệnh SHORT'}...`);
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`💰 [${symbol}] Khớp Market, đợi 3s để sync vị thế...`);
            await new Promise(r => setTimeout(r, 3000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            if (upPos && Math.abs(parseFloat(upPos.positionAmt)) > 0) {
                const entry = parseFloat(upPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', entry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: entry, qty: Math.abs(parseFloat(upPos.positionAmt)), 
                    tp: sync.tp, sl: sync.sl, firstMargin: isDCA ? currentPos.firstMargin : marginToUse, 
                    dcaCount: isDCA ? currentPos.dcaCount + 1 : 0, isProcessing: false, hedgeOpened: isDCA ? currentPos.hedgeOpened : false 
                });
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi Open/DCA ${symbol}: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

// GIÁM SÁT REAL-TIME VÀ CHỐT KHẨN CẤP
async function priceMonitorLoop() {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = Date.now() + 600000; // Blacklist 10p
                botActivePositions.delete(key);
                addBotLog(`✅ [${botPos.symbol}] Vị thế đã đóng thành công.`, "success");
                continue;
            }

            const markPrice = parseFloat(realPos.markPrice);
            botPos.markPrice = markPrice;
            botPos.pnl = parseFloat(realPos.unRealizedProfit);

            // CƠ CHẾ DỰ PHÒNG: NẾU GIÁ CHẠM TP/SL MÀ SÀN CHƯA KHỚP LỆNH CHỜ
            const isShort = (botPos.side === 'SHORT');
            const hitTP = isShort ? (markPrice <= botPos.tp) : (markPrice >= botPos.tp);
            const hitSL = isShort ? (markPrice >= botPos.sl) : (markPrice <= botPos.sl);

            if ((hitTP || hitSL) && botPos.tp > 0) {
                addBotLog(`🚨 [${botPos.symbol}] PHÁT HIỆN GIÁ CHẠM TP/SL! Đang đóng Market khẩn cấp...`, "warning");
                const sideClose = isShort ? 'buy' : 'sell';
                try {
                    await exchange.createOrder(botPos.symbol, 'market', sideClose, Math.abs(parseFloat(realPos.positionAmt)), undefined, { positionSide: botPos.side });
                    await hardClearOrders(botPos.symbol);
                } catch (err) { addBotLog(`❌ Lỗi đóng khẩn cấp: ${err.message}`, "error"); }
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1000); 
}

// VÒNG LẶP CHÍNH QUẢN LÝ DCA & HEDGE
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    for (let [key, botPos] of botActivePositions) {
        if (botPos.isProcessing) continue;
        const priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
        
        // DCA (Tối đa 4 lần)
        if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) {
            await openPosition(botPos.symbol, true);
        } 
        // Sau 4 lần DCA, nếu giá tăng tiếp 20% so với entry (DCA lần 5) thì HEDGE
        else if (priceDev >= (botSettings.dcaStep * 1.2) && botPos.dcaCount >= botSettings.maxDCA && !botPos.hedgeOpened) {
            botPos.hedgeOpened = true;
            await openHedgeLong(botPos.symbol, botPos.firstMargin, status.exchangeInfo[botPos.symbol]);
        }
    }

    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const keo = status.candidatesList.find(c => {
            const info = status.exchangeInfo[c.symbol];
            const hasVol = [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
            return info && (status.blackList[c.symbol] || 0) < Date.now() && !botActivePositions.has(`${c.symbol}_SHORT`) && hasVol;
        });
        if (keo) await openPosition(keo.symbol, false);
    }
}

// KHỞI TẠO HỆ THỐNG
async function init() {
    addBotLog("🚀 Luffy Bot đang khởi động...");
    await checkIP(); await syncTime();
    try {
        await exchange.loadMarkets();
        const [infoRes, brkRes] = await Promise.all([
            binanceApi.get('/fapi/v1/exchangeInfo'),
            binancePrivate('/fapi/v1/leverageBracket')
        ]);
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brkRes.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.isReady = true; addBotLog("👿 LUFFY BOT ONLINE - FULL PROTECTION ENABLED", "success");
        priceMonitorLoop();
    } catch (e) { addBotLog("⚠️ Lỗi khởi động: " + e.message); setTimeout(init, 5000); }
}

init(); 
setInterval(mainLoop, 4000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 3000);

const APP = express(); APP.use(express.json());
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
