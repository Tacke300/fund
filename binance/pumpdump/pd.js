import https from 'https';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CẤU HÌNH HỆ THỐNG - BERSERKER MODE (VÃ MARKET BẤT CHẤP)
// ============================================================================
let botSettings = { 
    isRunning: false,
    maxPositions: 3,            // Số lệnh tối đa mở cùng lúc
    invValue: 1,               // Số tiền mỗi lệnh (% hoặc USD)
    invType: 'percent',          
    
    minVol: 6.5,                // % biến động nến để vào lệnh
    entryCooldown: 3000,        // Nghỉ giữa các lần vào lệnh (3s)
    
    posTP: 0.5,                 // Chốt lời (%)
    posSL: 5.0,                 // Cắt lỗ (%)
    maxHoldTime: 1,            // Phút tối đa giữ lệnh (Hết giờ tự đóng)
    
    dailyLossLimit: 50.0,       // % lỗ tối đa trong ngày
    maxConsecutiveLosses: 5,    
    riskLoopSpeed: 500          
};

// ============================================================================
// 📊 TRẠNG THÁI HỆ THỐNG
// ============================================================================
let status = { 
    initialBalance: 0, dayStartBalance: 0, currentBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [], 
    globalCooldown: 0, consecutiveLosses: 0 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 📝 NHẬT KÝ CHI TIẾT (TERMINAL & HTML)
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 500) status.botLogs.pop();

    let color = '\x1b[36m'; 
    if (type === 'success') color = '\x1b[32m'; 
    if (type === 'error') color = '\x1b[31m';   
    if (type === 'warning') color = '\x1b[33m'; 
    if (type === 'entry') color = '\x1b[35m';   
    
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

// 🛡️ API CORE - XỬ LÝ LỖI SÀN
async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, timeout: 4000, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { 
                        if (d.startsWith('<')) return reject(new Error("HTML response (Check IP/Proxy)"));
                        try { resolve(JSON.parse(d)); } catch (e) { reject(e); } 
                    });
                });
                req.on('timeout', () => { req.destroy(); reject(new Error('Mạng lag/Timeout')); });
                req.on('error', reject);
                req.end();
            });

            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(400); }
    }
}

// 🚀 MỞ VỊ THẾ - FIX LỖI TP SL THỰC TẾ
async function openPosition(symbol, side, info, signals) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    try {
        addBotLog(`🚀 [TÍN HIỆU] ${symbol} đạt ${signals.maxV.toFixed(2)}%. VÃ MARKET!`, "entry");

        const acc = await callBinance('/fapi/v2/account');
        const available = parseFloat(acc.availableBalance);
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        
        if (margin > available) {
            addBotLog(`❌ Thất bại ${symbol}: Thiếu vốn`, "error");
            return;
        }

        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const currentPrice = parseFloat(ticker.price);
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const lev = brackets[0]?.brackets[0]?.initialLeverage || 20;
        
        let finalQty = (Math.floor(((margin * lev) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });
        pendingSymbols.add(symbol);
        
        const order = await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty 
        });

        if (order.orderId) {
            addBotLog(`⚡ Khớp Market ${symbol}. Đợi 3s lấy entry thật...`, "info");
            await sleep(3000); 

            const detail = await callBinance('/fapi/v1/order', 'GET', { symbol, orderId: order.orderId });
            const realEntry = parseFloat(detail.avgPrice || currentPrice);
            
            const priceCheck = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const nowPrice = parseFloat(priceCheck.price);

            addBotLog(`✅ XÁC NHẬN: ${symbol} khớp @ ${realEntry}`, "success");
            activeOrdersTracker.set(symbol, { symbol, side: posSide, entry: realEntry, openTime: Date.now() });

            const tp = (side === 'BUY' ? realEntry * (1 + botSettings.posTP/100) : realEntry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (side === 'BUY' ? realEntry * (1 - botSettings.posSL/100) : realEntry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            let isPassed = (side === 'BUY' && (nowPrice >= tp || nowPrice <= sl)) || (side === 'SELL' && (nowPrice <= tp || nowPrice >= sl));

            if (isPassed) {
                addBotLog(`⚠️ Giá (${nowPrice}) vượt TP/SL. Đóng MARKET ngay!`, "warning");
                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol, side: closeSide, positionSide: posSide, type: 'MARKET', quantity: finalQty, reduceOnly: 'true' 
                });
            } else {
                addBotLog(`🛡️ Đang cài Giáp ${symbol}: TP ${tp} | SL ${sl}`, "info");
                
                // Cài TP
                const resTP = await callBinance('/fapi/v1/order', 'POST', { 
                    symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE' 
                });
                // Cài SL
                const resSL = await callBinance('/fapi/v1/order', 'POST', { 
                    symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' 
                });

                if (resTP.orderId && resSL.orderId) {
                    addBotLog(`🎯 Giáp Verify OK cho ${symbol}`, "success");
                } else {
                    addBotLog(`❌ Lỗi đặt TP/SL trên sàn cho ${symbol}`, "error");
                }
            }
        }
    } catch (e) {
        addBotLog(`❌ LỖI VÀO LỆNH ${symbol}: ${e.message}`, "error");
    } finally {
        setTimeout(() => pendingSymbols.delete(symbol), 3000);
    }
}

// ⚡ VÒNG LẶP CHÍNH - QUẢN LÝ VỊ THẾ THỰC TẾ
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);

        // Đưa các vị thế mở tay/mở ngoài vào tracker để quản lý
        activePositions.forEach(p => {
            if (!activeOrdersTracker.has(p.symbol)) {
                activeOrdersTracker.set(p.symbol, { 
                    symbol: p.symbol, 
                    side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT', 
                    entry: parseFloat(p.entryPrice), 
                    openTime: Date.now() 
                });
                addBotLog(`👁️ Đồng bộ vị thế sàn: ${p.symbol}`, "warning");
            }
        });

        // Kiểm tra dọn dẹp lệnh đã đóng
        for (let [symbol, data] of activeOrdersTracker) {
            if (!activePositions.some(p => p.symbol === symbol)) {
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.find(t => t.symbol === symbol);
                const pnl = parseFloat(lastTrade?.realizedPnl || 0);

                if (pnl > 0) addBotLog(`💰 CHỐT LỜI: ${symbol} | Lãi: +${pnl}$`, "success");
                else addBotLog(`📉 CẮT LỖ/ĐÓNG: ${symbol} | PnL: ${pnl}$`, "error");

                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                activeOrdersTracker.delete(symbol);
            }
        }

        // Chốt chặn Max Positions theo sàn
        if (activePositions.length >= botSettings.maxPositions) return;

        for (const coin of status.candidatesList) {
            if (activePositions.some(p => p.symbol === coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            if (coin.maxV >= botSettings.minVol) {
                openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol], coin);
                break; 
            }
        }
    } catch (e) {}
}

// 📡 LẤY DỮ LIỆU TOP BIẾN ĐỘNG
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({
                    symbol: c.symbol, c1: c.c1, c5: c.c5, c15: c.c15 || c.m15 || 0,
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5), Math.abs(c.c15 || c.m15 || 0))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = status.dayStartBalance = parseFloat(acc.totalWalletBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notional = s.filters.find(f => f.filtersType === 'MIN_NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), minNotional: parseFloat(notional?.notional || 5) };
        });
        addBotLog("👿 LUFFY v15.7 FINAL - HỆ THỐNG ĐÃ KÍCH HOẠT!", "success");
    } catch (e) { console.log("Lỗi khởi tạo:", e.message); }
}

init(); 
setInterval(mainLoop, 3500);

// 🖥️ SERVER DASHBOARD
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => {
    Object.keys(req.body).forEach(key => {
        if (botSettings[key] !== req.body[key]) addBotLog(`⚙️ CẤU HÌNH: ${key} [${botSettings[key]}] -> [${req.body[key]}]`, "warning");
    });
    botSettings = { ...botSettings, ...req.body };
    res.json({ success: true });
});
APP.listen(9001);
