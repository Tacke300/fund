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
// ⚙️ CẤU HÌNH HỆ THỐNG (SETTINGS)
// ============================================================================
let botSettings = { 
    isRunning: false,
    maxPositions: 3,
    invValue: 1,
    invType: 'percent',
    
    minVol: 6.5,                
    maxSpread: 0.12,            
    minLiquidity: 10000,        
    entryCooldown: 15000,       
    
    posTP: 0.5,                 
    posSL: 3.0,                 
    enableBE: true,             
    beTrigger: 0.85,            
    maxHoldTime: 1,             
    
    dailyLossLimit: 50.0,        
    maxConsecutiveLosses: 3,    
    riskLoopSpeed: 700          
};

// ============================================================================
// 📊 TRẠNG THÁI & NHẬT KÝ
// ============================================================================
let status = { 
    initialBalance: 0, dayStartBalance: 0, currentBalance: 0, 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [],
    globalCooldown: 0, 
    consecutiveLosses: 0 
};

let activeOrdersTracker = new Map(); 
let pendingSymbols = new Set();
let serverTimeOffset = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 📝 HÀM LOG SIÊU CẤP - HIỂN THỊ CẢ TERMINAL VÀ HTML
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    // Đẩy log vào mảng để HTML hiển thị
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 300) status.botLogs.pop(); // Tăng bộ nhớ log lên 300 dòng

    // Hiển thị màu sắc trên Terminal để dễ soi
    let color = '\x1b[36m'; // Cyan cho Info
    if (type === 'success') color = '\x1b[32m'; // Green
    if (type === 'error') color = '\x1b[31m';   // Red
    if (type === 'warning') color = '\x1b[33m'; // Yellow
    if (type === 'entry') color = '\x1b[35m';   // Magenta cho lệnh vào
    
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

// 🛡️ API CORE VỚI LOG LỖI CHI TIẾT
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
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('timeout', () => { req.destroy(); reject(new Error('Mạng lag/Timeout API')); });
                req.on('error', reject);
                req.end();
            });

            if (res.code === -1021) { 
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }

            // Log lỗi từ phía sàn nếu có
            if (res.code && res.code !== 200) {
                addBotLog(`❌ Lỗi sàn (${endpoint}): ${res.msg} (Code: ${res.code})`, "error");
            }

            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(500); }
    }
}

// 🚀 HÀM MỞ LỆNH VỚI LOG LÝ DO CHI TIẾT
async function openPosition(symbol, side, info, signals) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    try {
        // 1. Kiểm tra điều kiện đầu vào (Spread, Liquidity)
        const depth = await callBinance('/fapi/v1/depth', 'GET', { symbol, limit: 10 });
        const ask = parseFloat(depth.asks[0][0]);
        const bid = parseFloat(depth.bids[0][0]);
        const spread = ((ask - bid) / bid) * 100;
        const volDepth = depth.bids.slice(0,5).reduce((a,b)=>a+(parseFloat(b[0])*parseFloat(b[1])), 0);

        // LOG LÝ DO VÀO LỆNH HOẶC BỊ TỪ CHỐI
        const logContext = `[${symbol}] Biến động: ${signals.maxV.toFixed(2)}% | Spread: ${spread.toFixed(3)}% | Liq: ${Math.round(volDepth)}$`;

        if (spread > botSettings.maxSpread) {
            addBotLog(`⚠️ Bỏ qua ${symbol}: Spread quá cao (${spread.toFixed(3)}% > ${botSettings.maxSpread}%)`, "warning");
            return;
        }
        if (volDepth < botSettings.minLiquidity) {
            addBotLog(`⚠️ Bỏ qua ${symbol}: Thanh khoản ảo (${Math.round(volDepth)}$ < ${botSettings.minLiquidity}$)`, "warning");
            return;
        }

        // 2. Check vốn thực tế
        const acc = await callBinance('/fapi/v2/account');
        const available = parseFloat(acc.availableBalance);
        
        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        
        if (margin > available) {
            addBotLog(`❌ Thất bại mở lệnh ${symbol}: Không đủ Margin (Cần ${margin.toFixed(2)}$, có ${available.toFixed(2)}$)`, "error");
            return;
        }

        // 3. Tính toán Quantity
        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const lev = brackets[0]?.brackets[0]?.initialLeverage || 20;
        let rawQty = (margin * lev) / ask;
        let minQty = (info.minNotional * 1.1) / ask;
        let finalQty = (Math.floor(Math.max(rawQty, minQty) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });

        // 4. Khớp lệnh
        addBotLog(`🔥 ĐANG MỞ VỊ THẾ ${posSide} ${symbol}... ${logContext}`, "entry");
        pendingSymbols.add(symbol);
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty });

        if (order.orderId) {
            await sleep(1000);
            const detail = await callBinance('/fapi/v1/order', 'GET', { symbol, orderId: order.orderId });
            const realEntry = parseFloat(detail.avgPrice || ask);
            
            addBotLog(`✅ THÀNH CÔNG: ${symbol} khớp giá ${realEntry}`, "success");
            activeOrdersTracker.set(symbol, { symbol, side: posSide, entry: realEntry, isBE: false, tpId: null, slId: null, openTime: Date.now() });

            // 5. Cài đặt TP/SL
            setTimeout(async () => {
                const tp = (side === 'BUY' ? realEntry * (1 + botSettings.posTP/100) : realEntry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
                const sl = (side === 'BUY' ? realEntry * (1 - botSettings.posSL/100) : realEntry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

                addBotLog(`🛡️ Đang cài Giáp cho ${symbol}: TP ${tp} | SL ${sl}`, "info");
                const rTP = await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE' });
                const rSL = await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' });

                await sleep(2500);
                const openOrders = await callBinance('/fapi/v1/openOrders', 'GET', { symbol });
                const hasTP = openOrders.some(o => o.type === 'TAKE_PROFIT_MARKET' && o.symbol === symbol);
                const hasSL = openOrders.some(o => o.type === 'STOP_MARKET' && o.symbol === symbol);

                if (hasTP && hasSL) {
                    addBotLog(`🎯 Giáp Verify OK: ${symbol} đã được bảo vệ hoàn toàn`, "success");
                } else {
                    addBotLog(`🚨 CẢNH BÁO: ${symbol} cài giáp thất bại! Đang đóng vị thế khẩn cấp.`, "error");
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'MARKET', closePosition: 'true' });
                    activeOrdersTracker.delete(symbol);
                }
            }, 1500);
        }
    } catch (e) { addBotLog(`❌ Lỗi hệ thống khi mở lệnh ${symbol}: ${e.message}`, "error"); }
    finally { setTimeout(()=>pendingSymbols.delete(symbol), 10 * 60 * 1000); }
}

// 📡 LẤY DỮ LIỆU BIẾN ĐỘNG & LOG TRẠNG THÁI
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

async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);

        // Kiểm tra xem vị thế đã đóng chưa để log kết quả
        for (let [symbol, data] of activeOrdersTracker) {
            if (!activePositions.some(p => p.symbol === symbol)) {
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastTrade = trades.find(t => t.symbol === symbol);
                const pnl = parseFloat(lastTrade?.realizedPnl || 0);
                
                if (pnl > 0) {
                    addBotLog(`💰 CHỐT LỜI: ${symbol} | Lãi: +${pnl}$`, "success");
                    status.consecutiveLosses = 0;
                } else {
                    addBotLog(`📉 CẮT LỖ/ĐÓNG: ${symbol} | PnL: ${pnl}$`, "error");
                }
                
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                activeOrdersTracker.delete(symbol);
            }
        }

        // Logic quét tín hiệu
        if (activePositions.length >= botSettings.maxPositions) return;

        for (const coin of status.candidatesList) {
            if (activePositions.some(p => p.symbol === coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            
            if (coin.maxV >= botSettings.minVol) {
                // Truyền signals vào để log lý do
                openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol], coin);
                break; 
            }
        }
    } catch (e) {}
}

// ⚙️ SERVER GIAO DIỆN & LOG CẤU HÌNH
const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));

APP.post('/api/settings', (req, res) => {
    // Log sự thay đổi cấu hình
    Object.keys(req.body).forEach(key => {
        if (botSettings[key] !== req.body[key]) {
            addBotLog(`⚙️ THAY ĐỔI CẤU HÌNH: ${key} [${botSettings[key]}] -> [${req.body[key]}]`, "warning");
        }
    });
    botSettings = { ...botSettings, ...req.body };
    res.json({ success: true });
});

async function init() {
    try {
        const acc = await callBinance('/fapi/v2/account');
        status.initialBalance = status.dayStartBalance = parseFloat(acc.totalWalletBalance);
        const info = await callBinance('/fapi/v1/exchangeInfo');
        info.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notional = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            status.exchangeInfo[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(lot.stepSize), minNotional: parseFloat(notional?.notional || 5) };
        });
        addBotLog("👿 LUFFY v15.2 BLACKBOX - Hệ thống giám sát đã kích hoạt!", "success");
    } catch (e) { console.log("Lỗi khởi tạo:", e.message); }
}

init(); 
setInterval(mainLoop, 3500);
setInterval(() => { if(botSettings.isRunning) addBotLog(`📡 Heartbeat: Bot đang quét tín hiệu... (${activeOrdersTracker.size} lệnh mở)`, "info"); }, 300000); // 5p log 1 lần cho đỡ trống terminal

APP.listen(9001);
