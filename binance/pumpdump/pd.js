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
// ⚙️ CẤU HÌNH HỆ THỐNG
// ============================================================================
let botSettings = { 
    isRunning: false,
    maxPositions: 3,            
    invValue: 6.5,               // Tăng lên > 5 USDT để tránh lỗi Min Notional
    invType: 'usd',             // Chuyển sang USD cho chắc chắn đạt Min Notional
    
    minVol: 6.5,                
    entryCooldown: 3000,        
    
    posTP: 0.5,                 
    posSL: 5.0,                 
    maxHoldTime: 1,             
    
    dailyLossLimit: 50.0,       
    maxConsecutiveLosses: 5,    
    riskLoopSpeed: 500          
};

let status = { 
    initialBalance: 0, dayStartBalance: 0, currentBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [], 
    globalCooldown: 0, consecutiveLosses: 0 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// 🛡️ API CORE - FIX LỖI HTML & TIMEOUT
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
                        if (d.startsWith('<')) return reject(new Error("Sàn trả về HTML (Lỗi hệ thống/IP)"));
                        try { resolve(JSON.parse(d)); } catch (e) { reject(e); } 
                    });
                });
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                req.on('error', reject);
                req.end();
            });

            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// 🚀 MỞ VỊ THẾ & CÀI GIÁP TỰ ĐỘNG
async function openPosition(symbol, side, info, signals) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    try {
        addBotLog(`🚀 [TÍN HIỆU] ${symbol} vọt ${signals.maxV.toFixed(2)}%. VÃ MARKET!`, "entry");

        // 1. Tính toán khối lượng (Đảm bảo > 5 USDT)
        const acc = await callBinance('/fapi/v2/account');
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        
        if (margin < 6) margin = 6; // Force min 6$ để tránh lỗi Notional

        const ticker = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
        const currentPrice = parseFloat(ticker.price);
        const lev = 20; // Default leverage
        
        let finalQty = (Math.floor(((margin * lev) / currentPrice) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        // 2. Vào lệnh Market
        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });
        pendingSymbols.add(symbol);
        
        const order = await callBinance('/fapi/v1/order', 'POST', { 
            symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty 
        });

        if (order.orderId) {
            addBotLog(`⚡ Khớp Market ${symbol}. Đợi 3s xác nhận entry...`, "info");
            await sleep(3000); // Đợi 3s theo yêu cầu

            // 3. Lấy giá khớp thực tế
            const detail = await callBinance('/fapi/v1/order', 'GET', { symbol, orderId: order.orderId });
            const realEntry = parseFloat(detail.avgPrice || currentPrice);
            addBotLog(`✅ XÁC NHẬN: ${symbol} khớp @ ${realEntry}`, "success");

            // 4. Tính toán TP/SL
            const tp = (side === 'BUY' ? realEntry * (1 + botSettings.posTP/100) : realEntry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
            const sl = (side === 'BUY' ? realEntry * (1 - botSettings.posSL/100) : realEntry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

            // 5. KIỂM TRA GIÁ TỨC THÌ TRƯỚC KHI ĐẶT LỆNH CHỜ
            const checkPrice = await callBinance('/fapi/v1/ticker/price', 'GET', { symbol });
            const nowPrice = parseFloat(checkPrice.price);
            
            let isPricePast = (side === 'BUY' && (nowPrice >= tp || nowPrice <= sl)) || 
                             (side === 'SELL' && (nowPrice <= tp || nowPrice >= sl));

            if (isPricePast) {
                addBotLog(`⚠️ Giá hiện tại (${nowPrice}) đã vượt TP/SL. ĐÓNG MARKET NGAY!`, "warning");
                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol, side: closeSide, positionSide: posSide, type: 'MARKET', quantity: finalQty, reduceOnly: 'true' 
                });
            } else {
                addBotLog(`🛡️ Cài Giáp: TP ${tp} | SL ${sl}`, "info");
                // Sử dụng STOP_MARKET / TAKE_PROFIT_MARKET đúng chuẩn Algo
                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE' 
                });
                await callBinance('/fapi/v1/order', 'POST', { 
                    symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' 
                });
            }
            activeOrdersTracker.set(symbol, { symbol, side: posSide, entry: realEntry, openTime: Date.now() });
        }
    } catch (e) {
        addBotLog(`❌ LỖI: ${e.message}`, "error");
    } finally {
        setTimeout(() => pendingSymbols.delete(symbol), 3000);
    }
}

// ⚡ VÒNG LẶP THEO DÕI
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);

        for (let [symbol, data] of activeOrdersTracker) {
            if (!activePositions.some(p => p.symbol === symbol)) {
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.find(t => t.symbol === symbol);
                const pnl = parseFloat(lastTrade?.realizedPnl || 0);
                
                if (pnl > 0) addBotLog(`💰 LÃI: ${symbol} | +${pnl}$`, "success");
                else addBotLog(`📉 LỖ/ĐÓNG: ${symbol} | ${pnl}$`, "error");

                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
                activeOrdersTracker.delete(symbol);
            }
        }

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

// 📡 FETCH DATA & INIT
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
            try {
                const r = JSON.parse(d);
                status.candidatesList = (r.live || []).map(c => ({
                    symbol: c.symbol, c1: c.c1, c5: c.c5, 
                    maxV: Math.max(Math.abs(c.c1), Math.abs(c.c5))
                })).sort((a, b) => b.maxV - a.maxV);
            } catch (e) {}
        });
    }).on('error', () => {});
}, 2000);

async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = parseFloat(acc.totalWalletBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                minNotional: parseFloat(notional?.notional || 5) 
            };
        });
        addBotLog("👿 LUFFY v15.8 - READY TO RUMBLE!", "success");
    } catch (e) { console.log("Init Error:", e.message); }
}

init(); 
setInterval(mainLoop, 4000);

// 🖥️ SERVER
const APP = express(); APP.use(express.json());
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => {
    botSettings = { ...botSettings, ...req.body };
    res.json({ success: true });
});
APP.listen(9001);
