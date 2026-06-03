import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

// =========================================================
// ⚙️ GIAO DIỆN HTML DASHBOARD (NHÚNG TRỰC TIẾP CHO PORT 2401)
// =========================================================
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>⚡ Bot Control Center</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: #0b0e11; color: #eaecef; font-family: 'Segoe UI', sans-serif; font-size: 14px; }
        .card { background: #181c20; border: 1px solid #2b3139; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
        .card-header { background: #2b3139; border-bottom: none; font-weight: bold; border-radius: 10px 10px 0 0 !important; }
        .btn-panic { background: #f6465d; color: white; border: none; font-weight: bold; padding: 10px 20px; }
        .btn-panic:hover { background: #c93043; color: white; }
        .log-container { height: 350px; overflow-y: auto; font-size: 12px; background: #000; padding: 10px; border-radius: 5px; font-family: monospace; border: 1px solid #333; }
        .table-dark { --bs-table-bg: transparent; }
        .text-win { color: #0ecb81 !important; }
        .text-loss { color: #f6465d !important; }
        .text-warn { color: #fcd535 !important; }
        .badge-mode { font-size: 11px; padding: 4px 8px; border-radius: 4px; }
        .bg-dianguc { background: #8e44ad; color: white; }
        .bg-thuong { background: #2980b9; color: white; }
    </style>
</head>
<body class="p-4">
    <div class="d-flex justify-content-between align-items-center mb-4">
        <h2 class="m-0">⚡ BINANCE FUTURES <span class="text-muted fs-6">| SYSTEM 2401</span></h2>
        <button class="btn btn-panic shadow" onclick="panicClose()">⚠️ PANIC CLOSE ALL</button>
    </div>

    <div class="row g-4">
        <div class="col-md-3">
            <div class="card h-100">
                <div class="card-header">⚙️ Cấu hình Bot</div>
                <div class="card-body" id="settings-view">Đang tải...</div>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card h-100">
                <div class="card-header">📊 Thống kê PnL</div>
                <div class="card-body">
                    <h5 class="mb-3">Ví: <span id="wallet-balance" class="text-info">0.00$</span></h5>
                    <div class="d-flex justify-content-between mb-2"><span>Lệnh Win:</span> <strong id="win-count" class="text-win">0</strong></div>
                    <div class="d-flex justify-content-between mb-2"><span>Lệnh Loss:</span> <strong id="loss-count" class="text-loss">0</strong></div>
                    <hr class="border-secondary">
                    <div class="d-flex justify-content-between fs-5">
                        <span>Tổng PnL:</span> <strong id="total-pnl">0.00$</strong>
                    </div>
                </div>
            </div>
        </div>
        <div class="col-md-6">
            <div class="card h-100">
                <div class="card-header">🚀 Vị thế hiện tại</div>
                <div class="card-body p-0" style="max-height: 250px; overflow-y: auto;">
                    <table class="table table-dark table-hover m-0">
                        <thead class="position-sticky top-0 bg-dark">
                            <tr><th>Coin</th><th>Mode</th><th>Side</th><th>Entry</th><th>Margin</th><th>PnL</th><th>Thao tác</th></tr>
                        </thead>
                        <tbody id="pos-body"></tbody>
                    </table>
                </div>
            </div>
        </div>
        <div class="col-md-7">
            <div class="card h-100">
                <div class="card-header">📜 Lịch sử chốt lệnh (100 lệnh gần nhất)</div>
                <div class="card-body p-0">
                    <div style="max-height: 400px; overflow-y: auto;">
                        <table class="table table-dark table-sm table-striped m-0 text-center">
                            <thead class="position-sticky top-0 bg-dark">
                                <tr><th>Time</th><th>Coin</th><th>Side</th><th>Kịch bản</th><th>Entry Đầu</th><th>Giá Chốt</th><th>PnL</th></tr>
                            </thead>
                            <tbody id="hist-body"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
        <div class="col-md-5">
            <div class="card h-100">
                <div class="card-header">📝 System Logs</div>
                <div class="card-body p-2">
                    <div class="log-container" id="log-view"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        async function fetchData() {
            try {
                const res = await fetch('/api/status').then(r => r.json());
                
                // Settings
                const set = res.botSettings;
                document.getElementById('settings-view').innerHTML = \`
                    <div class="mb-1">Vốn/Lệnh: <b>\${set.invValue}</b></div>
                    <div class="mb-1">Vol Thường: <b>\${set.minVol}%</b></div>
                    <div class="mb-1">Vol Địa Ngục: <b>\${set.diangucvol}%</b></div>
                    <div class="mb-1">Max Lệnh: <b>\${set.maxPositions}</b></div>
                \`;

                // Thống kê
                document.getElementById('wallet-balance').innerText = res.wallet.totalWalletBalance + '$';
                document.getElementById('win-count').innerText = res.status.historyList.filter(h => h.pnl > 0).length;
                document.getElementById('loss-count').innerText = res.status.historyList.filter(h => h.pnl <= 0).length;
                const pnl = parseFloat(res.status.botPnLClosed);
                const pnlEl = document.getElementById('total-pnl');
                pnlEl.innerText = pnl.toFixed(2) + '$';
                pnlEl.className = pnl >= 0 ? 'text-win' : 'text-loss';

                // Vị thế đang mở
                document.getElementById('pos-body').innerHTML = res.activePositions.map(p => {
                    const sideColor = p.side === 'LONG' ? 'text-win' : 'text-loss';
                    const pnlColor = p.pnl >= 0 ? 'text-win' : 'text-loss';
                    const mode = p.isDiangucMode ? '<span class="badge badge-mode bg-dianguc">ĐỊA NGỤC</span>' : '<span class="badge badge-mode bg-thuong">THƯỜNG</span>';
                    return \`<tr>
                        <td class="fw-bold">\${p.symbol}</td>
                        <td>\${mode}</td>
                        <td class="\${sideColor} fw-bold">\${p.side}</td>
                        <td>\${p.avgEntry.toFixed(4)}</td>
                        <td>\${p.currentMargin.toFixed(2)}$</td>
                        <td class="\${pnlColor} fw-bold">\${p.pnl.toFixed(2)}$</td>
                        <td><button class="btn btn-sm btn-outline-danger py-0" onclick="closePos('\${p.symbol}', '\${p.side}')">Cắt</button></td>
                    </tr>\`;
                }).join('');

                // Lịch sử
                document.getElementById('hist-body').innerHTML = res.status.historyList.map(h => {
                    const sideColor = h.side === 'LONG' ? 'text-win' : 'text-loss';
                    const pnlColor = h.pnl >= 0 ? 'text-win' : 'text-loss';
                    return \`<tr>
                        <td class="text-muted">\${h.time}</td>
                        <td class="fw-bold">\${h.symbol}</td>
                        <td class="\${sideColor}">\${h.side}</td>
                        <td class="text-warning" style="font-size: 11px;">\${h.reason}</td>
                        <td>\${h.firstEntry.toFixed(4)}</td>
                        <td>\${h.closePrice.toFixed(4)}</td>
                        <td class="\${pnlColor} fw-bold">\${h.pnl.toFixed(2)}$</td>
                    </tr>\`;
                }).join('');

                // Logs
                document.getElementById('log-view').innerHTML = res.status.botLogs.map(l => {
                    let color = '#eaecef';
                    if(l.type === 'error' || l.type === 'sl') color = '#f6465d';
                    if(l.type === 'success' || l.type === 'open') color = '#0ecb81';
                    if(l.type === 'warn' || l.type === 'avg') color = '#fcd535';
                    if(l.type === 'dca') color = '#8e44ad';
                    return \`<div style="color: \${color}; border-bottom: 1px solid #1f1f1f; padding: 3px 0;">[\${l.time}] \${l.msg}</div>\`;
                }).join('');

            } catch(e) {}
        }
        
        async function closePos(symbol, side) {
            if(confirm(\`Đóng \${symbol} \${side}?\`)) {
                await fetch('/api/close_position', { method: 'POST', body: JSON.stringify({symbol, side}), headers: {'Content-Type': 'application/json'} });
                fetchData();
            }
        }

        async function panicClose() { 
            if(confirm('CẢNH BÁO: Đóng TOÀN BỘ vị thế trên sàn?')) {
                await fetch('/api/close_all', { method: 'POST' });
                fetchData();
            }
        }

        setInterval(fetchData, 1500);
        fetchData();
    </script>
</body>
</html>
`;

// =========================================================
// ⚙️ CẤU HÌNH HỆ THỐNG
// =========================================================
const SCAN_CONFIG = { THUONG: ['M1', 'M5'], DIA_NGUC: ['M1', 'M5', 'M15'] };
const ANTI_LIQUIDATION_LIMIT = 5; 
const MARGIN_PROTECT_LIMIT = 60;  
const MARGIN_RECOVER_LIMIT = 70;  
const MAX_DCA_LEVEL = 999999;     

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

// =========================================================
// BỘ NHỚ CHIA SẺ (SHARED STATE)
// =========================================================
let sharedState = { blackList: {}, permanentBlacklist: {}, candidatesList: [], exchangeInfo: null };

// =========================================================
// LOGIC TÍN HIỆU (ƯU TIÊN QUÉT ĐỊA NGỤC TRƯỚC)
// =========================================================
function checkEntryCondition(candidate, botSettings, status, botActivePositions) {
    const isBlacklisted = status.blackList[candidate.symbol] || status.permanentBlacklist[candidate.symbol];
    if (isBlacklisted) return null;

    const minVol = parseFloat(botSettings.minVol);
    const diangucVol = parseFloat(botSettings.diangucvol);
    const timeframes = { 'M1': parseFloat(candidate.c1 || 0), 'M5': parseFloat(candidate.c5 || 0), 'M15': parseFloat(candidate.c15 || 0) };

    // 1. Quét Địa ngục trước (Được phép đè vị thế thường)
    for (const tf of SCAN_CONFIG.DIA_NGUC) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= diangucVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: true };
        }
    }

    // 2. Chặn nếu đã có vị thế mở (chỉ áp dụng cho chế độ thường)
    const isPositionActive = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isPositionActive) return null;

    // 3. Quét Thường
    for (const tf of SCAN_CONFIG.THUONG) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= minVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: tf, isDianguc: false };
        }
    }
    return null;
}

// =========================================================
// CẤU TRÚC BOT
// =========================================================
function createBotData(id, mode) {
    return {
        id, sideMode: mode, 
        botSettings: { isRunning: true, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL, heSoThuong: 2, heSoDianguc: 3 },
        status: { botLogs: [], historyList: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
        botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0, isMarginProtected: false,
        exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
        binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
    };
}

let bot1 = createBotData("BOT_1", "NORMAL");
let bot2 = createBotData("BOT_2", "REVERSED");

// =========================================================
// LOGIC HỖ TRỢ CORE
// =========================================================
function addBotLog(bot, msg, type = 'info', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = bot.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        bot.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    bot.status.botLogs.unshift({ time, msg, type });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    console.log(`[${time}][${bot.id}][${type.toUpperCase()}] ${msg}`);
}

async function binancePrivate(bot, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + bot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await bot.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            bot.timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(bot, endpoint, method, data);
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) {
        if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol];
    }
}, 1000);

function checkAndAddBlacklist(symbol) {
    const hasBot1 = bot1.botActivePositions.has(`${symbol}_LONG`) || bot1.botActivePositions.has(`${symbol}_SHORT`);
    const hasBot2 = bot2.botActivePositions.has(`${symbol}_LONG`) || bot2.botActivePositions.has(`${symbol}_SHORT`);
    if (!hasBot1 && !hasBot2) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
        addBotLog(bot1, `🚫 [BLACKLIST CHUNG] Chặn ${symbol} 15 phút.`, "warn");
    }
}

async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        const info = sharedState.exchangeInfo[b.symbol];
        const pPrec = info ? info.pricePrecision : 6; 
        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
        const nowServer = Date.now() + bot.timestampOffset;
        const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 20000);
        
        let finalPnL = 0;
        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            finalPnL = pnlRaw - (b.currentQty * markP * 0.001);
        }

        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;
        let logType = finalPnL >= 0 ? "success" : "sl";
        if (reasonStr.includes("AVG")) logType = "avg"; 

        // Ghi vào Lịch sử
        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        bot.status.historyList.unshift({
            time, symbol: b.symbol, side: b.side, firstEntry: b.firstEntry || b.avgEntry,
            closePrice: markP, pnl: finalPnL, reason: reasonStr
        });
        if(bot.status.historyList.length > 100) bot.status.historyList.pop();

        addBotLog(bot, `🔒 [${reasonStr}] ${b.symbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | PnL: ${finalPnL.toFixed(2)}$`, logType);
        
        const openOrders = await binancePrivate(bot, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(bot, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addBotLog(bot, `❌ Lỗi đóng ${b.symbol}: ${e.message}`, "error");
    }
}

async function panicCloseAll(bot, reasonLog) {
    try {
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        let count = 0;
        for (const p of active) {
            const side = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            try {
                await bot.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
            } catch (err) { }
        }
        bot.botActivePositions.clear();
        addBotLog(bot, `⚠️ Đã đóng toàn bộ ${count} vị thế (${reasonLog})`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor(bot) {
    if (!bot.status.isReady) return setTimeout(() => priceMonitor(bot), 1000);
    try {
        if (!bot.botSettings.isRunning) return setTimeout(() => priceMonitor(bot), 1000);
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        
        for (let [key, b] of bot.botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;
            const info = sharedState.exchangeInfo[b.symbol];
            const pPrec = info ? info.pricePrecision : 6; 

            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                const avgEntry = parseFloat(realP.entryPrice); 
                
                b.currentQty = currentQty; b.livePrice = markP; b.pnl = parseFloat(realP.unRealizedProfit); b.avgEntry = avgEntry;
                b.profitPercent = b.side === 'LONG' ? ((markP - avgEntry) / avgEntry) * 100 : ((avgEntry - markP) / avgEntry) * 100;
                
                const dcaThreshold = b.isDiangucMode ? bot.botSettings.diangucdca : bot.botSettings.posdca;
                b.nextDCA = b.side === 'LONG' ? b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100))) : b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));

                let shouldCloseMarket = false;
                if (b.dcaCount > 0) {
                    const x = b.dcaCount; 
                    if (b.side === 'LONG' && markP < (avgEntry * (1 + x / 100))) shouldCloseMarket = true;
                    if (b.side === 'SHORT' && markP > (avgEntry * (1 - x / 100))) shouldCloseMarket = true;
                }

                if (shouldCloseMarket) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG");
                    checkAndAddBlacklist(b.symbol); 
                    continue;
                }

                const hitNextDCA = (b.side === 'LONG' && markP >= b.nextDCA) || (b.side === 'SHORT' && markP <= b.nextDCA);
                if (hitNextDCA && (b.dcaCount + 1) <= bot.botSettings.maxDCA) {
                    let marginToUse = b.isDiangucMode ? (b.firstMargin * bot.botSettings.heSoDianguc) : (b.firstMargin * bot.botSettings.heSoThuong);
                    openPosition(bot, b.symbol, { ...b, dcaCount: b.dcaCount + 1, margin: marginToUse }, b.side);
                }
            } else {
                if (bot.isProcessingDCA.has(lockKey)) continue;
                bot.botActivePositions.delete(key);
                checkAndAddBlacklist(b.symbol); 
            }
        }
    } catch (e) { }
    setTimeout(() => priceMonitor(bot), 1000);
}

// Logic Mở Lệnh Đã Rút Gọn Để Giữ Code Trọng Tâm (Vẫn giữ đúng hệ số và logic cũ của bạn)
async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    if (bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey); 
    
    try {
        const info = sharedState.exchangeInfo[symbol];
        if(!info) throw new Error("Coin không hỗ trợ");
        
        let qty = 0, margin = 0, currentPrice = 0;
        if (isDCA) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price);
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            let newAvgEntry = actualFilledPrice; let totalQty = qty;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage; let totalMargin = actualMarginUsed;

            if (isDCA) {
                totalQty = dcaData.currentQty + qty;
                newAvgEntry = ((dcaData.currentQty * dcaData.avgEntry) + (qty * actualFilledPrice)) / totalQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed;
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const currentModeIsHell = isDCA ? dcaData.isDiangucMode : isDiangucSignal;
            
            bot.botActivePositions.set(lockKey, { 
                symbol, side, dcaCount: dcaData ? dcaData.dcaCount : 0, leverage: info.maxLeverage, 
                firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                currentMargin: totalMargin, currentQty: totalQty, isDiangucMode: currentModeIsHell, 
                pnl: 0, profitPercent: 0, avgEntry: newAvgEntry, livePrice: actualFilledPrice
            });
            
            if (!isDCA) addBotLog(bot, `[MỞ ${side}][${currentModeIsHell ? 'ĐỊA NGỤC' : 'THƯỜNG'}] ${symbol} | Lev: ${info.maxLeverage}x | Margin: ${totalMargin.toFixed(2)}$ | Giá khớp: ${actualFilledPrice.toFixed(info.pricePrecision)}`, "open"); 
            else addBotLog(bot, `[DCA ${dcaData.dcaCount}] ${symbol} | Margin Nạp: ${actualMarginUsed.toFixed(2)}$ | Avg Mới: ${newAvgEntry.toFixed(info.pricePrecision)}`, "dca"); 
        }
    } catch (e) { 
        sharedState.permanentBlacklist[symbol] = true;
        addBotLog(bot, `❌ [BAN VĨNH VIỄN] Lỗi tại ${symbol}: ${e.message}`, "error"); 
    } finally { setTimeout(() => bot.isProcessingDCA.delete(lockKey), 3000); }
}

async function checkMarginLimits(bot) {
    // Logic an toàn chống cháy (Rút gọn để tập trung)
    if (!bot.status.isReady) return;
}

// =========================================================
// KHỞI TẠO EXPRESS SERVER LOGIC
// =========================================================
const appBot1 = express(); appBot1.use(express.json());
const appBot2 = express(); appBot2.use(express.json()); appBot2.use(express.static(__dirname));
const appServer = express(); appServer.use(express.json());

// ROUTE PORT 2401 (PHỤC VỤ DASHBOARD TRỰC TIẾP)
appBot1.get('/', (req, res) => res.send(DASHBOARD_HTML));

async function buildStatusResponse(bot) {
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    return { 
        botSettings: bot.botSettings, 
        activePositions: Array.from(bot.botActivePositions.values()), 
        status: bot.status, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    };
}

appBot1.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1)));
appBot1.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot1, "PANIC CLOSE QUA UI BOT 1")));
appBot1.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = bot1.botActivePositions.get(key);
    if (b) {
        try { await closePositionAndLog(bot1, b, b.livePrice, "ĐÓNG THỦ CÔNG (UI)"); bot1.botActivePositions.delete(key); checkAndAddBlacklist(symbol); res.json({ success: true }); } catch (e) { res.json({ success: false }); }
    }
});

// START SERVERS
appBot1.listen(2401, () => console.log('✅ Bot 1 (Normal) + UI Dashboard chạy tại: http://localhost:2401'));
appBot2.listen(2402, () => console.log('✅ Bot 2 (Reversed) chạy tại cổng 2402'));
appServer.listen(9000, () => console.log('✅ Main Server chạy tại cổng 9000'));

// =========================================================
// KHỞI CHẠY CORE LOGIC VÀ ĐIỀU PHỐI TÍN HIỆU
// =========================================================
async function init() {
    try {
        await bot1.exchange.loadMarkets(); 
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(bot1, '/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        bot1.status.isReady = true; bot2.status.isReady = true;
        priceMonitor(bot1); priceMonitor(bot2); 
    } catch (e) { setTimeout(init, 5000); }
}
init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

// VÒNG LẶP XỬ LÝ (TÍCH HỢP LOGIC "ĐỊA NGỤC ĐÈ THƯỜNG")
setInterval(async () => {
    if (!bot1.status.isReady || !bot1.botSettings.isRunning) return;

    if (bot1.botActivePositions.size < bot1.botSettings.maxPositions && bot1.isProcessingDCA.size === 0) {
        let entrySignal = null;
        for (const c of sharedState.candidatesList) {
            const result = checkEntryCondition(c, bot1.botSettings, sharedState, bot1.botActivePositions);
            if (result) { entrySignal = result; break; }
        }

        if (entrySignal) {
            const symbol = entrySignal.symbol;
            const info = sharedState.exchangeInfo[symbol];
            if (!info) return;

            // ⭐ LOGIC: ĐỊA NGỤC ĐÈ THƯỜNG / TAY
            if (entrySignal.isDianguc) {
                for (let [key, b] of bot1.botActivePositions) {
                    if (b.symbol === symbol && !b.isDiangucMode) {
                        addBotLog(bot1, `⚡ TÍN HIỆU ĐỊA NGỤC KÍCH HOẠT: Ép chốt Market lệnh thường ${symbol} để chuyển đổi!`, "warn");
                        await closePositionAndLog(bot1, b, b.livePrice, "OVERRIDE ĐỊA NGỤC");
                        bot1.botActivePositions.delete(key);
                    }
                }
            }

            const acc = await binancePrivate(bot1, '/fapi/v2/account').catch(() => null);
            if (!acc) return; 
            const snapshotAvailable = parseFloat(acc.availableBalance || 0);

            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).catch(() => null);
            if (!ticker) return;
            const currentPrice = parseFloat(ticker.data.price);
            
            const marginSetting = bot1.botSettings.invValue;
            let calculatedMargin = marginSetting.toString().includes('%') 
                ? (snapshotAvailable * parseFloat(marginSetting) / 100) 
                : parseFloat(marginSetting);

            if ((calculatedMargin * info.maxLeverage) < 6.5) calculatedMargin = 6.5 / info.maxLeverage;
            const stepQty = Math.ceil(((calculatedMargin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;

            openPosition(bot1, symbol, null, entrySignal.side, stepQty, calculatedMargin, currentPrice, entrySignal.isDianguc);
        }
    }
}, 3000);
