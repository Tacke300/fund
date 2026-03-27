import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// ⚙️ CẤU HÌNH HỆ THỐNG (SETTINGS) - CHỈNH TẠI ĐÂY
// ============================================================================
let botSettings = { 
    isRunning: false,           // Trạng thái chạy của bot (True/False)
    maxPositions: 3,            // Số lệnh tối đa mở cùng lúc (Tránh phân tán vốn)
    invValue: 1.5,              // Số tiền vào mỗi lệnh (% hoặc USD tùy invType)
    invType: 'percent',         // Cách tính tiền vào lệnh: 'percent' hoặc 'fixed'
    
    // --- [ CHIẾN THUẬT ENTRY ] ---
    minVol: 2.2,                // Biến động tối thiểu (%) của nến để kích hoạt vào lệnh
    maxSpread: 0.12,            // Khoảng cách Bid/Ask tối đa (%) để chấp nhận (Tránh coin rác)
    minLiquidity: 10000,        // Thanh khoản tối thiểu trong Top 10 lệnh (USD) để vào lệnh an toàn
    entryCooldown: 15000,       // Thời gian nghỉ giữa các lần vào lệnh (ms)
    
    // --- [ GIÁP BẢO VỆ (TP/SL) ] ---
    posTP: 1.2,                 // Chốt lời (%) tính từ điểm khớp lệnh thật
    posSL: 3.0,                 // Cắt lỗ (%) tính từ điểm khớp lệnh thật
    enableBE: true,             // Bật/Tắt dời SL về điểm hòa vốn (Break-Even)
    beTrigger: 0.85,            // Lãi đạt mức này (%) thì dời SL về Entry + 0.05% phí
    maxHoldTime: 5,             // Thời gian ôm lệnh tối đa (Phút). Hết giờ tự đóng Market bất kể lời lỗ.
    
    // --- [ QUẢN TRỊ RỦI RO CHIẾN TRƯỜNG ] ---
    dailyLossLimit: 5.0,        // Giới hạn lỗ trong ngày (%). Chạm mức này bot nghỉ đến 00:00 VN
    maxConsecutiveLosses: 3,    // "Kill Switch": Thua liên tiếp n lệnh thì tự tắt Bot để check lại
    riskLoopSpeed: 700,         // Tốc độ quét rủi ro (ms). 700ms là mức an toàn cho API Rate Limit
};

// ============================================================================
// 📊 TRẠNG THÁI HỆ THỐNG (SYSTEM STATUS)
// ============================================================================
let status = { 
    initialBalance: 0, dayStartBalance: 0, currentBalance: 0, 
    botLogs: [], exchangeInfo: {}, candidatesList: [], 
    globalCooldown: 0, consecutiveLosses: 0 
};

let activeOrdersTracker = new Map(); // Theo dõi lệnh đang chạy
let pendingSymbols = new Set();      // Chống vào lệnh lặp khi đang xử lý
let serverTimeOffset = 0;            // Lệch múi giờ với Binance

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hàm ghi Log hiển thị lên Dashboard và Terminal
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    const color = type === 'success' ? '\x1b[32m' : (type === 'error' ? '\x1b[31m' : '\x1b[36m');
    console.log(`${color}[${time}] ${msg}\x1b[0m`);
}

// 🛡️ API CORE - Xử lý gọi sàn, ký tên và chống lỗi Timeout
async function callBinance(endpoint, method = 'GET', params = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const timestamp = Date.now() + serverTimeOffset;
            const query = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
            const fullQuery = query + (query ? '&' : '') + `timestamp=${timestamp}&recvWindow=10000`;
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(fullQuery).digest('hex');
            const url = `https://fapi.binance.com${endpoint}?${fullQuery}&signature=${signature}`;

            const res = await new Promise((resolve, reject) => {
                const req = https.request(url, { method, timeout: 3500, headers: { 'X-MBX-APIKEY': API_KEY } }, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
                });
                req.on('timeout', () => { req.destroy(); reject(new Error('Timeout API')); });
                req.on('error', reject);
                req.end();
            });

            if (res.code === -1021) { // Lỗi lệch thời gian hệ thống
                const t = await new Promise(r => https.get('https://fapi.binance.com/fapi/v1/time', res => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>r(JSON.parse(d))); }));
                serverTimeOffset = t.serverTime - Date.now();
                continue;
            }
            return res;
        } catch (e) { if (i === retries - 1) throw e; await sleep(400); }
    }
}

// ⚡ RISK MANAGER - Vòng lặp quét giá Mark liên tục để xử lý SL/BE siêu tốc
async function riskManager() {
    if (!botSettings.isRunning || activeOrdersTracker.size === 0) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);

        for (let p of activePositions) {
            const data = activeOrdersTracker.get(p.symbol);
            if (!data) continue;

            const markP = parseFloat(p.markPrice);
            const profit = data.side === 'LONG' ? (markP - data.entry)/data.entry*100 : (data.entry - markP)/data.entry*100;

            // 1. AUTO-KILL SL: Đóng bằng lệnh Market nếu giá chạm SL mà lệnh SL của sàn chưa khớp
            if (profit <= -botSettings.posSL) {
                addBotLog(`🚨 [AUTO-KILL] ${p.symbol} âm ${profit.toFixed(2)}%`, "error");
                await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side: data.side === 'LONG' ? 'SELL' : 'BUY', positionSide: data.side, type: 'MARKET', closePosition: 'true' });
                activeOrdersTracker.delete(p.symbol);
                status.consecutiveLosses++;
                continue;
            }

            // 2. ATOMIC BREAK-EVEN: Đặt SL mới xong mới xóa SL cũ (Chống Race Condition)
            if (botSettings.enableBE && !data.isBE && profit >= botSettings.beTrigger) {
                const beP = data.side === 'LONG' ? (data.entry * 1.0005).toFixed(status.exchangeInfo[p.symbol].pricePrecision) : (data.entry * 0.9995).toFixed(status.exchangeInfo[p.symbol].pricePrecision);
                const newSL = await callBinance('/fapi/v1/order', 'POST', { symbol: p.symbol, side: data.side === 'LONG' ? 'SELL' : 'BUY', positionSide: data.side, type: 'STOP_MARKET', stopPrice: beP, closePosition: 'true', workingType: 'MARK_PRICE' });
                if (newSL.orderId) {
                    if (data.slId) await callBinance('/fapi/v1/order', 'DELETE', { symbol: p.symbol, orderId: data.slId }).catch(()=>{});
                    data.isBE = true; data.slId = newSL.orderId;
                    addBotLog(`🛡️ BE SECURED: ${p.symbol}`, "success");
                }
            }
        }
        
        // Kiểm tra Kill Switch (Dừng bot nếu thua quá nhiều lệnh liên tiếp)
        if (status.consecutiveLosses >= botSettings.maxConsecutiveLosses) {
            botSettings.isRunning = false;
            addBotLog(`💀 KILL SWITCH: Tắt Bot do dính chuỗi ${status.consecutiveLosses} lệnh lỗ`, "error");
        }
    } catch (e) {}
}

// 🚀 HÀM MỞ VỊ THẾ - Xử lý lọc Spread, Thanh khoản và khớp lệnh chuẩn
async function openPosition(symbol, side, info) {
    const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    try {
        // 1. LẤY CHI TIẾT SỔ LỆNH (Check Spread & Thanh khoản thực)
        const depth = await callBinance('/fapi/v1/depth', 'GET', { symbol, limit: 10 });
        const ask = parseFloat(depth.asks[0][0]);
        const bid = parseFloat(depth.bids[0][0]);
        const spread = ((ask - bid) / bid) * 100;
        const volDepth = depth.bids.slice(0,5).reduce((a,b)=>a+(parseFloat(b[0])*parseFloat(b[1])), 0);

        if (spread > botSettings.maxSpread || volDepth < botSettings.minLiquidity) {
            addBotLog(`⚠️ Bỏ qua ${symbol}: Spread ${spread.toFixed(3)}% | Thanh khoản: ${Math.round(volDepth)}$`, "error");
            return;
        }

        // 2. KIỂM TRA SỐ DƯ & LEVERAGE
        const acc = await callBinance('/fapi/v2/account');
        const available = parseFloat(acc.availableBalance);
        const dailyLoss = ((status.dayStartBalance - parseFloat(acc.totalWalletBalance)) / status.dayStartBalance) * 100;

        if (dailyLoss >= botSettings.dailyLossLimit) {
            botSettings.isRunning = false;
            addBotLog(`🛑 DỪNG: Chạm giới hạn lỗ ngày (${dailyLoss.toFixed(2)}%)`, "error");
            return;
        }

        const brackets = await callBinance('/fapi/v1/leverageBracket', 'GET', { symbol });
        const lev = brackets[0]?.brackets[0]?.initialLeverage || 20;

        let margin = botSettings.invType === 'percent' ? (parseFloat(acc.totalWalletBalance) * botSettings.invValue) / 100 : botSettings.invValue;
        
        if (margin > available) {
            addBotLog(`❌ Thiếu vốn: Cần ${margin.toFixed(2)}$, Hiện có ${available.toFixed(2)}$`, "error");
            return;
        }

        // 3. TÍNH QTY CHUẨN (Fix lỗi Min Notional)
        let rawQty = (margin * lev) / ask;
        let minQty = (info.minNotional * 1.1) / ask; // Thêm 10% buffer cho an toàn
        let finalQty = (Math.floor(Math.max(rawQty, minQty) / info.stepSize) * info.stepSize).toFixed(info.quantityPrecision);

        await callBinance('/fapi/v1/leverage', 'POST', { symbol, leverage: lev });

        // 4. ENTRY MARKET
        pendingSymbols.add(symbol);
        const order = await callBinance('/fapi/v1/order', 'POST', { symbol, side, positionSide: posSide, type: 'MARKET', quantity: finalQty });

        if (order.orderId) {
            status.globalCooldown = Date.now() + (status.consecutiveLosses > 0 ? 30000 : botSettings.entryCooldown);
            
            // Lấy AvgPrice thực tế từ Order Detail (Tránh lỗi Split Fill)
            await sleep(1000);
            const detail = await callBinance('/fapi/v1/order', 'GET', { symbol, orderId: order.orderId });
            const realEntry = parseFloat(detail.avgPrice || ask);
            
            addBotLog(`🚀 ENTRY OK: ${symbol} @ ${realEntry} (Size: ${finalQty})`, "info");
            activeOrdersTracker.set(symbol, { symbol, side: posSide, entry: realEntry, isBE: false, tpId: null, slId: null });

            // 5. ĐẶT GIÁP (TP/SL) & VERIFY CHUYÊN SÂU
            setTimeout(async () => {
                const tp = (side === 'BUY' ? realEntry * (1 + botSettings.posTP/100) : realEntry * (1 - botSettings.posTP/100)).toFixed(info.pricePrecision);
                const sl = (side === 'BUY' ? realEntry * (1 - botSettings.posSL/100) : realEntry * (1 + botSettings.posSL/100)).toFixed(info.pricePrecision);

                const rTP = await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp, closePosition: 'true', workingType: 'MARK_PRICE' });
                const rSL = await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', stopPrice: sl, closePosition: 'true', workingType: 'MARK_PRICE' });

                await sleep(2500); // Chờ sàn đồng bộ
                const openOrders = await callBinance('/fapi/v1/openOrders', 'GET', { symbol });
                const myOrders = openOrders.filter(o => o.symbol === symbol);
                const hasTP = myOrders.some(o => o.type === 'TAKE_PROFIT_MARKET');
                const hasSL = myOrders.some(o => o.type === 'STOP_MARKET');

                if (!hasTP || !hasSL) {
                    addBotLog(`🛡️ LỖI GIÁP: ${symbol} thiếu bảo vệ. Đóng Market khẩn cấp!`, "error");
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'MARKET', closePosition: 'true' });
                    activeOrdersTracker.delete(symbol);
                } else {
                    const d = activeOrdersTracker.get(symbol);
                    if(d) { d.tpId = rTP.orderId; d.slId = rSL.orderId; }
                    addBotLog(`🎯 Giáp Verify OK: ${symbol}`, "success");
                }
            }, 1500);

            // 6. THỜI GIAN ÔM LỆNH TỐI ĐA (Timeout Close)
            setTimeout(async () => {
                if (activeOrdersTracker.has(symbol)) {
                    addBotLog(`⏱ HẾT GIỜ (${botSettings.maxHoldTime}P): Đóng lệnh ${symbol}`, "info");
                    await callBinance('/fapi/v1/order', 'POST', { symbol, side: closeSide, positionSide: posSide, type: 'MARKET', closePosition: 'true' });
                    activeOrdersTracker.delete(symbol);
                }
            }, botSettings.maxHoldTime * 60 * 1000);
        }
    } catch (e) { addBotLog(`❌ Lỗi Mở Vị Thế: ${e.message}`, "error"); }
    finally { setTimeout(()=>pendingSymbols.delete(symbol), 10 * 60 * 1000); }
}

// Hàm vòng lặp chính để quét tín hiệu và kiểm tra trạng thái
async function mainLoop() {
    if (!botSettings.isRunning) return;
    try {
        const posRisk = await callBinance('/fapi/v2/positionRisk');
        const activePositions = posRisk.filter(p => parseFloat(p.positionAmt) !== 0);

        // Đồng bộ tracker và reset chuỗi thua nếu thắng
        for (let [symbol, data] of activeOrdersTracker) {
            if (!activePositions.some(p => p.symbol === symbol)) {
                const trades = await callBinance('/fapi/v1/userTrades', 'GET', { symbol, limit: 5 });
                const lastPnl = parseFloat(trades[0]?.realizedPnl || 0);
                if (lastPnl > 0) status.consecutiveLosses = 0;
                
                addBotLog(`✨ ${symbol} HOÀN TẤT | PnL: ${lastPnl}$`, "success");
                await callBinance('/fapi/v1/allOpenOrders', 'DELETE', { symbol }).catch(()=>{});
                activeOrdersTracker.delete(symbol);
            }
        }

        if (activePositions.length >= botSettings.maxPositions || Date.now() < status.globalCooldown) return;

        for (const coin of status.candidatesList) {
            if (activePositions.some(p => p.symbol === coin.symbol) || pendingSymbols.has(coin.symbol)) continue;
            
            // Kiểm tra biến động để vào lệnh
            if (coin.maxV >= botSettings.minVol) {
                openPosition(coin.symbol, coin.c1 >= 0 ? 'BUY' : 'SELL', status.exchangeInfo[coin.symbol]);
                break; 
            }
        }
    } catch (e) {}
}

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
        addBotLog("👿 LUFFY v15.0 HEDGE FUND ELITE - Gear 5 Ready!", "success");

        // RESET Tiền vốn ngày vào đúng 00:00 giờ VN
        setInterval(() => {
            const now = new Date();
            if (now.getHours() === 0 && now.getMinutes() === 0) {
                status.dayStartBalance = status.currentBalance;
                addBotLog("📅 Daily Balance Reset!", "info");
            }
        }, 60000);
    } catch (e) { console.log("Init Error:", e.message); }
}

init(); 
setInterval(mainLoop, 3500); // Vòng lặp quét tín hiệu
setInterval(riskManager, botSettings.riskLoopSpeed); // Vòng lặp bảo vệ tài khoản

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(activeOrdersTracker.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
