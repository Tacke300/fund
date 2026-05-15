import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// ==========================================
// CẤU HÌNH CỐ ĐỊNH
// ==========================================
const MAX_DCA_LEVEL = 3; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Khởi tạo các instance API
const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true, 
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        recvWindow: 10000, 
        adjustForTimeDifference: true 
    } 
});

// State của hệ thống
let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 1.2, posSL: 10.0, maxDCA: MAX_DCA_LEVEL };
let status = { botLogs: [], candidatesList: [], blackList: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); // Chỉ chứa lệnh do Bot mở
let isProcessingDCA = new Set();
let timestampOffset = 0;

// --- HÀM TRỢ GIÚP ---
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
        const response = await binanceApi({ 
            method, 
            url: `${endpoint}?${query}&signature=${signature}` 
        });
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

// --- MONITOR: QUẢN LÝ RIÊNG LỆNH BOT ---
async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        // Chỉ lặp qua các lệnh mà Bot đang quản lý trong Map()
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            
            if (realP) {
                // Cập nhật trạng thái lệnh Bot
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;

                if (b.currentQty !== currentQty) { 
                    b.currentQty = currentQty; 
                    b.hitTime = null; 
                }

                // Kiểm tra TP/SL cứng (Phòng hờ API sàn lỗi)
                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);

                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        addBotLog(`⚠️ ${b.symbol} (Bot) treo >30s. Đóng MARKET!`, "warn");
                        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', currentQty, undefined, { positionSide: b.side });
                    }
                } else { b.hitTime = null; }
            } else {
                // VỊ THẾ ĐÃ ĐÓNG (Hoặc bị thanh lý/DCA hụt)
                if (isProcessingDCA.has(b.symbol)) continue;

                const trades = await binancePrivate('/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 10 });
                const recent = trades.filter(t => t.time > (Date.now() + timestampOffset - 30000));
                
                let totalR = 0;
                recent.forEach(t => totalR += parseFloat(t.realizedPnl));
                
                botActivePositions.delete(key);
                status.botClosedCount++; 
                status.botPnLClosed += totalR;

                if (totalR > 0 || b.side === 'LONG') {
                    status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
                    addBotLog(`💰 BOT CHỐT ${b.symbol} | PnL: ${totalR.toFixed(2)}$`, "success");
                } else {
                    // Logic DCA nếu lỗ (Chỉ dành cho SHORT)
                    const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${b.symbol}`);
                    const jump = Math.max(b.dcaCount + 1, Math.floor((parseFloat(ticker.data.price) - b.firstEntry) / (b.firstEntry * botSettings.posSL/100)));
                    if (jump <= botSettings.maxDCA) openPosition(b.symbol, { ...b, dcaCount: jump, margin: b.firstMargin * (jump + 1) });
                    else openPosition(b.symbol, { ...b, isFinalLong: true, margin: b.firstMargin * 20 });
                }
            }
        }
    } catch (e) { console.error("Monitor Error:", e.message); }
    setTimeout(priceMonitor, 1000);
}

// --- SERVER API ---
const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((s, p) => s + (p.pnl || 0), 0);
        
        res.json({ 
            botSettings, 
            activePositions: Array.from(botActivePositions.values()),
            status: {
                ...status,
                blackList: Object.fromEntries(Object.entries(status.blackList).map(([s, t]) => [s, Math.max(0, Math.floor((t - Date.now()) / 1000))]))
            }, 
            wallet: { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
                totalUnrealizedProfit: botUnrealizedPnL.toFixed(2)
            } 
        });
    } catch (e) {
        res.json({ botSettings, activePositions: [], status, wallet: { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" } });
    }
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    addBotLog(`⚙️ Cấu hình đã được cập nhật`, "success");
    res.json({ success: true }); 
});

// --- LOGIC GIAO DỊCH ---
async function openPosition(symbol, dcaData = null) {
    if (isProcessingDCA.has(symbol)) return;
    isProcessingDCA.add(symbol);
    const side = dcaData?.isFinalLong ? 'LONG' : 'SHORT';
    try {
        const info = status.exchangeInfo[symbol];
        const acc = await binancePrivate('/fapi/v2/account');
        
        let margin = dcaData ? dcaData.margin : (botSettings.invValue.toString().includes('%') ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));
        if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
        
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        let qty = Math.ceil(((margin * info.maxLeverage) / price) / info.stepSize) * info.stepSize;
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = dcaData ? dcaData.firstEntry : entry;
                let tp = (side === 'LONG') ? entry * 1.10 : entry * (1 - botSettings.posTP/100);
                let sl = (side === 'LONG') ? entry * 0.90 : firstE + (firstE * botSettings.posSL/100);
                
                const sync = await syncTPSL(symbol, side, info, tp, sl);
                botActivePositions.set(`${symbol}_${side}`, { 
                    symbol, side, entryPrice: entry, tp: sync.tp, sl: sync.sl, 
                    dcaCount: dcaData ? dcaData.dcaCount : 0, 
                    leverage: info.maxLeverage, firstEntry: firstE, 
                    firstMargin: dcaData ? dcaData.firstMargin : margin, 
                    currentQty: Math.abs(parseFloat(p.positionAmt)), 
                    pnl: 0, priceDev: 0, hitTime: null 
                });
                addBotLog(`✅ BOT đã mở ${symbol} (${side})`);
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi mở lệnh: ${e.message}`, "error"); }
    finally { setTimeout(() => isProcessingDCA.delete(symbol), 2000); }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        }
        await new Promise(r => setTimeout(r, 600));
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: tpPrice, sl: slPrice }; }
}

// --- KHỞI TẠO ---
async function init() {
    try {
        const ipRes = await axios.get('https://api.ipify.org?format=json').catch(() => ({ data: { ip: "Lỗi IP" } }));
        console.log(`\n🚀 BOT ĐANG CHẠY TRÊN IP: ${ipRes.data.ip}`);

        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = t.data.serverTime - Date.now();
        
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            temp[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lotFilter.stepSize), 
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        status.exchangeInfo = temp; 
        status.isReady = true; 
        priceMonitor();
        addBotLog(`🔥 Hệ thống đã sẵn sàng!`);
    } catch (e) { 
        console.error("Init Error:", e.message);
        setTimeout(init, 5000); 
    }
}

init();

// Nhận dữ liệu từ scanner
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// Quét mở lệnh mới
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning) return;
    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const can = status.candidatesList.find(c => Math.abs(c.c1) >= botSettings.minVol && !status.blackList[c.symbol] && !botActivePositions.has(`${c.symbol}_SHORT`));
        if (can) openPosition(can.symbol);
    }
}, 3000);

APP.listen(9001);
