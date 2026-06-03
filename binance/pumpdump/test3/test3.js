import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import ccxt from 'ccxt';
import { API_KEY, SECRET_KEY } from './config.js';

// =========================================================
// 🌐 CONFIG ĐƯỜNG DẪN TUYỆT ĐỐI (FIX LỖI MÙ PORT 2402/2403)
// =========================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================
// 📈 GIAO DIỆN TERMINAL CHUYÊN NGHIỆP TRỰC TIẾP CHO PORT 2401
// =========================================================
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>⚡ PRO TERMINAL | SYSTEM 2401</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Roboto+Mono:wght@500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-base: #0b0e11;
            --bg-panel: #181c20;
            --bg-hover: #2b3139;
            --border-color: #2b3139;
            --text-main: #eaecef;
            --text-muted: #848e9c;
            --up-color: #0ecb81;
            --down-color: #f6465d;
        }
        body { 
            background: var(--bg-base); color: var(--text-main); 
            font-family: 'Inter', sans-serif; font-size: 13px; 
            height: 100vh; overflow: hidden; margin: 0; padding: 15px;
        }
        .number-font { font-family: 'Roboto Mono', monospace; letter-spacing: -0.5px; }
        
        /* Panel Styling */
        .panel { 
            background: var(--bg-panel); border: 1px solid var(--border-color); 
            border-radius: 8px; display: flex; flex-direction: column; height: 100%;
        }
        .panel-header { 
            padding: 10px 15px; font-weight: 600; font-size: 13px; 
            border-bottom: 1px solid var(--border-color); color: var(--text-main);
            display: flex; justify-content: space-between; align-items: center;
            background: #1f242a; border-radius: 8px 8px 0 0;
        }
        .panel-body { padding: 12px; overflow-y: auto; flex-grow: 1; }
        
        /* Table Styling */
        .table { margin-bottom: 0; color: var(--text-main); font-size: 13px; }
        .table th { border-bottom: 1px solid var(--border-color); color: var(--text-muted); font-weight: 500; border-top: none; padding: 8px; }
        .table td { border-bottom: 1px solid var(--border-color); padding: 8px; vertical-align: middle; }
        .table tbody tr:hover { background-color: var(--bg-hover) !important; }
        .sticky-head { position: sticky; top: 0; background: #181c20; z-index: 10; }
        
        /* Custom Scrollbar */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #474d57; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #5e6673; }

        /* Typography & Colors */
        .text-win { color: var(--up-color) !important; }
        .text-loss { color: var(--down-color) !important; }
        .text-right { text-align: right; }
        .text-center { text-align: center; }
        
        /* Badges & Buttons */
        .badge-mode { padding: 4px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; display: inline-block; }
        .bg-dianguc { background: rgba(142, 68, 173, 0.2); color: #c39bd3; border: 1px solid #8e44ad; }
        .bg-thuong { background: rgba(41, 128, 185, 0.2); color: #7fb3d5; border: 1px solid #2980b9; }
        
        .btn-panic { 
            background: var(--down-color); color: white; border: none; 
            font-weight: 600; font-size: 12px; padding: 8px 16px; border-radius: 4px; transition: 0.2s;
        }
        .btn-panic:hover { background: #c93043; }
        .btn-cut { background: transparent; border: 1px solid var(--down-color); color: var(--down-color); font-size: 11px; padding: 2px 8px; border-radius: 3px; transition: 0.2s; }
        .btn-cut:hover { background: var(--down-color); color: white; }

        /* Log Styling */
        .log-line { font-family: 'Roboto Mono', monospace; font-size: 12px; padding: 4px 0; border-bottom: 1px dashed #2b3139; line-height: 1.5; }
        .log-time { color: var(--text-muted); margin-right: 8px; }
        
        /* Layout Grid Không Dùng Tab */
        .grid-container { display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr 1.2fr; gap: 15px; height: calc(100vh - 70px); }
        .box-top { grid-column: span 2; display: flex; gap: 15px; height: 90px; }
        .box-top > div { flex: 1; }
        .box-pos { grid-column: 1; grid-row: 2; }
        .box-log { grid-column: 2; grid-row: span 2; }
        .box-hist { grid-column: 1; grid-row: 3; }
    </style>
</head>
<body>
    <div class="d-flex justify-content-between align-items-center mb-3">
        <h4 class="m-0" style="font-weight: 600; letter-spacing: -0.5px;">⚡ CORE SYSTEM CONTROL <span style="color: var(--text-muted); font-size: 13px; font-weight: 400;">| PORT 2401</span></h4>
        <div class="d-flex align-items-center gap-4">
            <div class="number-font" style="font-size: 16px; font-weight: 600;">Tổng Ký Quỹ Ví: <span id="wallet-balance" style="color: #fcd535;">0.00$</span></div>
            <button class="btn-panic" onclick="panicClose()">⚠️ PANIC CLOSE ALL MARKET</button>
        </div>
    </div>

    <div class="grid-container">
        <div class="box-top">
            <div class="panel">
                <div class="panel-header">⚙️ Cấu hình Bot Hiện Tại</div>
                <div class="panel-body d-flex justify-content-between align-items-center py-0" id="settings-view">Đang tải...</div>
            </div>
            <div class="panel">
                <div class="panel-header">📊 Thống kê Lệnh Chốt</div>
                <div class="panel-body d-flex justify-content-around align-items-center number-font py-0" style="font-size: 20px; font-weight: 700;">
                    <div class="text-win">WIN: <span id="win-count">0</span></div>
                    <div class="text-loss">LOSS: <span id="loss-count">0</span></div>
                </div>
            </div>
            <div class="panel">
                <div class="panel-header">💰 Tổng Lợi Nhuận Bot Chạy (PnL)</div>
                <div class="panel-body d-flex justify-content-center align-items-center number-font" style="font-size: 28px; font-weight: 700;" id="total-pnl">
                    0.00$
                </div>
            </div>
        </div>

        <div class="panel box-pos">
            <div class="panel-header">🚀 Vị thế đang hoạt động (<span id="pos-count">0</span>)</div>
            <div class="panel-body p-0">
                <table class="table table-borderless">
                    <thead class="sticky-head">
                        <tr>
                            <th>Coin</th>
                            <th class="text-center">Chế độ</th>
                            <th class="text-center">Side</th>
                            <th class="text-right">Entry Đầu / Avg</th>
                            <th class="text-right">Margin / DCA</th>
                            <th class="text-right">PnL Hiện Tại</th>
                            <th class="text-center">Thao tác</th>
                        </tr>
                    </thead>
                    <tbody id="pos-body"></tbody>
                </table>
            </div>
        </div>

        <div class="panel box-log">
            <div class="panel-header">📝 Live Logs Hệ Thống</div>
            <div class="panel-body" id="log-view" style="background: #06070a;"></div>
        </div>

        <div class="panel box-hist">
            <div class="panel-header">📜 Lịch sử khớp & chốt lệnh hệ thống</div>
            <div class="panel-body p-0">
                <table class="table table-borderless">
                    <thead class="sticky-head">
                        <tr>
                            <th class="text-center">STT</th>
                            <th>Thời gian</th>
                            <th>Coin</th>
                            <th class="text-center">Side</th>
                            <th>Kịch bản Chốt / Khớp</th>
                            <th class="text-right">Entry Đầu</th>
                            <th class="text-right">Giá Chốt</th>
                            <th class="text-right">Lợi Nhuận PnL</th>
                        </tr>
                    </thead>
                    <tbody id="hist-body"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let historyCounter = 1;
        async function fetchData() {
            try {
                const res = await fetch('/api/status').then(r => r.json());
                
                // Render Thông số cài đặt
                const set = res.botSettings;
                document.getElementById('settings-view').innerHTML = \`
                    <div>Vốn/Lệnh: <b class="number-font text-info">\${set.invValue}</b></div>
                    <div>Vol Thường: <b class="number-font">\${set.minVol}%</b></div>
                    <div>Vol Địa Ngục: <b class="number-font text-warning">\${set.diangucvol}%</b></div>
                    <div>Max Positions: <b class="number-font">\${set.maxPositions}</b></div>
                \`;

                // Render Thống kê
                document.getElementById('wallet-balance').innerText = parseFloat(res.wallet.totalWalletBalance).toFixed(2) + '$';
                const wins = res.status.historyList.filter(h => h.pnl > 0).length;
                const losses = res.status.historyList.filter(h => h.pnl <= 0).length;
                document.getElementById('win-count').innerText = wins;
                document.getElementById('loss-count').innerText = losses;
                
                const pnl = parseFloat(res.status.botPnLClosed);
                const pnlEl = document.getElementById('total-pnl');
                pnlEl.innerText = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '$';
                pnlEl.className = \`panel-body d-flex justify-content-center align-items-center number-font \${pnl >= 0 ? 'text-win' : 'text-loss'}\`;

                // Render Vị thế đang mở
                document.getElementById('pos-count').innerText = res.activePositions.length;
                document.getElementById('pos-body').innerHTML = res.activePositions.map(p => {
                    const sideColor = p.side === 'LONG' ? 'text-win' : 'text-loss';
                    const pnlColor = p.pnl >= 0 ? 'text-win' : 'text-loss';
                    const mode = p.isDiangucMode ? '<span class="badge-mode bg-dianguc">ĐỊA NGỤC</span>' : '<span class="badge-mode bg-thuong">THƯỜNG</span>';
                    return \`<tr>
                        <td style="font-weight: 600; color:#fff;">\${p.symbol}</td>
                        <td class="text-center">\${mode}</td>
                        <td class="text-center \${sideColor}" style="font-weight: 600;">\${p.side}</td>
                        <td class="text-right number-font">\${p.firstEntry.toFixed(4)} / <span class="text-warning">\${p.avgEntry.toFixed(4)}</span></td>
                        <td class="text-right number-font">\${p.currentMargin.toFixed(2)}$ / <span class="text-info">DCA \${p.dcaCount}</span></td>
                        <td class="text-right number-font \${pnlColor}" style="font-weight: 700;">\${(p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2)}$</td>
                        <td class="text-center"><button class="btn-cut" onclick="closePos('\${p.symbol}', '\${p.side}')">Cắt Lệnh</button></td>
                    </tr>\`;
                }).join('');

                // Render Lịch sử lệnh (Có số thứ tự STT tăng dần)
                let totalItems = res.status.historyList.length;
                document.getElementById('hist-body').innerHTML = res.status.historyList.map((h, index) => {
                    const sideColor = h.side === 'LONG' ? 'text-win' : 'text-loss';
                    const pnlColor = h.pnl >= 0 ? 'text-win' : 'text-loss';
                    return \`<tr>
                        <td class="text-center text-muted number-font">\${totalItems - index}</td>
                        <td class="text-muted number-font" style="font-size:11px;">\${h.time}</td>
                        <td style="font-weight: 600;">\${h.symbol}</td>
                        <td class="text-center \${sideColor}">\${h.side}</td>
                        <td style="color: #fcd535; font-size: 11px; font-weight:500;">\${h.reason}</td>
                        <td class="text-right number-font">\${h.firstEntry.toFixed(4)}</td>
                        <td class="text-right number-font">\${h.closePrice.toFixed(4)}</td>
                        <td class="text-right number-font \${pnlColor}" style="font-weight: 600;">\${(h.pnl >= 0 ? '+' : '') + h.pnl.toFixed(2)}$</td>
                    </tr>\`;
                }).join('');

                // Render Logs hệ thống có màu sắc phân loại kịch bản
                document.getElementById('log-view').innerHTML = res.status.botLogs.map(l => {
                    let color = 'var(--text-main)';
                    if(l.type === 'error' || l.type === 'sl') color = 'var(--down-color)';
                    if(l.type === 'success' || l.type === 'open') color = 'var(--up-color)';
                    if(l.type === 'warn' || l.type === 'avg') color = '#fcd535';
                    if(l.type === 'dca') color = '#c39bd3';
                    return \`<div class="log-line" style="color: \${color};">
                        <span class="log-time">[\${l.time}]</span>\${l.msg}
                    </div>\`;
                }).join('');

            } catch(e) {}
        }
        
        async function closePos(symbol, side) {
            if(confirm(\`Xác nhận đóng vị thế thị trường (MARKET) đồng \${symbol} \${side}?\`)) {
                await fetch('/api/close_position', { method: 'POST', body: JSON.stringify({symbol, side}), headers: {'Content-Type': 'application/json'} });
                fetchData();
            }
        }

        async function panicClose() { 
            if(confirm('🚨 CẢNH BÁO NGUY HIỂM: Bạn có chắc chắn muốn đóng TOÀN BỘ vị thế đang chạy trên sàn Binance bằng lệnh Market không?')) {
                await fetch('/api/close_all', { method: 'POST' });
                fetchData();
            }
        }

        setInterval(fetchData, 1000); // Tải dữ liệu Realtime 1 giây/lần cực mượt
        fetchData();
    </script>
</body>
</html>
`;

// =========================================================
// ⚙️ CẤU HÌNH HỆ THỐNG CORE
// =========================================================
const SCAN_CONFIG = { THUONG: ['M1', 'M5'], DIA_NGUC: ['M1', 'M5', 'M15'] };
const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = { blackList: {}, permanentBlacklist: {}, candidatesList: [], exchangeInfo: null };

// =========================================================
// FACTORY TẠO OBJECT DATA CHO TỪNG BOT ĐỘC LẬP
// =========================================================
function createBotData(id, mode) {
    return {
        id, sideMode: mode, 
        botSettings: { isRunning: true, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, dianguctp: 30, diangucsl: 10, diangucvol: 15, posdca: 3, diangucdca: 10, maxDCA: 9999, heSoThuong: 2, heSoDianguc: 3 },
        status: { botLogs: [], historyList: [], botClosedCount: 0, botPnLClosed: 0, isReady: false },
        botActivePositions: new Map(), isProcessingDCA: new Set(), logThrottle: new Map(), timestampOffset: 0,
        exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } })
    };
}

// Khởi tạo 3 Bot độc lập theo yêu cầu cấu trúc của bạn
let botChinh = createBotData("BOT_CHINH_2401", "NORMAL");
let bot1 = createBotData("BOT_1_2402", "NORMAL");
let bot2 = createBotData("BOT_2_2403", "REVERSED");

// =========================================================
// HELPER LOGS VÀ PRIVATE SIGNATURES
// =========================================================
function addBotLog(bot, msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    bot.status.botLogs.unshift({ time, msg, type });
    if (bot.status.botLogs.length > 200) bot.status.botLogs.pop();
    console.log(`[${time}][${bot.id}] ${msg}`);
}

async function binancePrivate(bot, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + bot.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
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

// =========================================================
// ⚡ CORE LOGIC: ĐIỀU KIỆN QUYẾT ĐỊNH & "ĐỊA NGỤC ĐÈ THƯỜNG/TAY"
// =========================================================
function checkEntryCondition(candidate, botSettings, botActivePositions) {
    if (sharedState.blackList[candidate.symbol] || sharedState.permanentBlacklist[candidate.symbol]) return null;

    const minVol = parseFloat(botSettings.minVol);
    const diangucVol = parseFloat(botSettings.diangucvol);
    const timeframes = { 'M1': parseFloat(candidate.c1 || 0), 'M5': parseFloat(candidate.c5 || 0), 'M15': parseFloat(candidate.c15 || 0) };

    // 🌟 ƯU TIÊN 1: Quét tín hiệu Địa ngục trước
    for (const tf of SCAN_CONFIG.DIA_NGUC) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= diangucVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: `ĐịaNgục_${tf}`, isDianguc: true };
        }
    }

    // Nếu đã mở vị thế của đồng này rồi thì không quét chế độ thường nữa
    const isAlreadyOpen = botActivePositions.has(`${candidate.symbol}_SHORT`) || botActivePositions.has(`${candidate.symbol}_LONG`);
    if (isAlreadyOpen) return null;

    // 🌟 ƯU TIÊN 2: Quét chế độ Thường
    for (const tf of SCAN_CONFIG.THUONG) {
        const val = timeframes[tf];
        if (val !== undefined && Math.abs(val) >= minVol) {
            return { symbol: candidate.symbol, side: val > 0 ? 'LONG' : 'SHORT', vol: Math.abs(val), reason: `Thường_${tf}`, isDianguc: false };
        }
    }
    return null;
}

// =========================================================
// 🚀 QUY TRÌNH THỰC THI VÀ THEO DÕI ĐÓNG/MỞ VỊ THẾ
// =========================================================
async function closePositionAndLog(bot, b, markP, reasonStr) {
    try {
        const info = sharedState.exchangeInfo[b.symbol];
        await bot.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        
        await new Promise(r => setTimeout(r, 800));
        const trades = await binancePrivate(bot, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 5 }).catch(() => []);
        let finalPnL = 0;
        if (trades.length > 0) {
            finalPnL = trades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            finalPnL = pnlRaw - (b.currentQty * markP * 0.001);
        }

        bot.status.botClosedCount++;
        bot.status.botPnLClosed += finalPnL;

        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        bot.status.historyList.unshift({ time, symbol: b.symbol, side: b.side, firstEntry: b.firstEntry, closePrice: markP, pnl: finalPnL, reason: reasonStr });
        
        addBotLog(bot, `🔒 Đóng vị thế ${b.symbol} ${b.side} [${reasonStr}] | PnL: ${finalPnL.toFixed(2)}$`, finalPnL >= 0 ? 'success' : 'sl');
    } catch (e) {
        addBotLog(bot, `❌ Lỗi thực thi lệnh đóng vị thế ${b.symbol}: ${e.message}`, "error");
    }
}

async function openPosition(bot, symbol, dcaData = null, forcedSide = null, sharedQty = null, sharedMargin = null, sharedPrice = null, isDiangucSignal = false) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT');
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    if (bot.isProcessingDCA.has(lockKey)) return;
    bot.isProcessingDCA.add(lockKey);

    try {
        const info = sharedState.exchangeInfo[symbol];
        let qty = 0, margin = 0, currentPrice = 0;

        if (isDCA) {
            const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
            currentPrice = parseFloat(ticker.data.price);
            margin = dcaData.margin;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            qty = sharedQty; margin = sharedMargin; currentPrice = sharedPrice;
        }

        await bot.exchange.setLeverage(info.maxLeverage, symbol);
        const order = await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            const actualPrice = order.average || order.price || currentPrice;
            let totalQty = qty; let totalMargin = margin; let newAvgEntry = actualPrice;

            if (isDCA) {
                totalQty = dcaData.currentQty + qty;
                newAvgEntry = ((dcaData.currentQty * dcaData.avgEntry) + (qty * actualPrice)) / totalQty;
                totalMargin = dcaData.currentMargin + margin;
            }

            bot.botActivePositions.set(lockKey, {
                symbol, side, dcaCount: isDCA ? dcaData.dcaCount : 0, leverage: info.maxLeverage,
                firstEntry: isDCA ? dcaData.firstEntry : actualPrice, firstMargin: isDCA ? dcaData.firstMargin : margin,
                currentMargin: totalMargin, currentQty: totalQty, isDiangucMode: isDCA ? dcaData.isDiangucMode : isDiangucSignal,
                pnl: 0, avgEntry: newAvgEntry, livePrice: actualPrice
            });

            if (!isDCA) addBotLog(bot, `🚀 Mở vị thế ${symbol} ${side} [${isDiangucSignal ? 'ĐỊA NGỤC' : 'THƯỜNG'}] thành công`, "open");
            else addBotLog(bot, ` lặp nạp DCA [Mức ${dcaData.dcaCount}] đồng ${symbol}`, "dca");
        }
    } catch (e) {
        addBotLog(bot, `❌ Thất bại mở lệnh ${symbol}: ${e.message}`, "error");
    } finally {
        setTimeout(() => bot.isProcessingDCA.delete(lockKey), 2000);
    }
}

// =========================================================
// VÒNG LẶP MONITOR GIÁ & DCA TRAILING REALTIME
// =========================================================
async function priceMonitor(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return setTimeout(() => priceMonitor(bot), 1000);
    try {
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk');
        for (let [key, b] of bot.botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            if (realP) {
                const markP = parseFloat(realP.markPrice);
                b.livePrice = markP;
                b.pnl = parseFloat(realP.unRealizedProfit);
                
                // Logic Trailing Chốt Lãi Avg của bạn
                let shouldCloseTrailing = false;
                if (b.dcaCount > 0) {
                    if (b.side === 'LONG' && markP < (b.avgEntry * (1 + b.dcaCount / 100))) shouldCloseTrailing = true;
                    if (b.side === 'SHORT' && markP > (b.avgEntry * (1 - b.dcaCount / 100))) shouldCloseTrailing = true;
                }

                if (shouldCloseTrailing) {
                    bot.botActivePositions.delete(key);
                    await closePositionAndLog(bot, b, markP, "CHỐT TRAILING AVG");
                    continue;
                }

                // Check điều kiện chạm mốc DCA tiếp theo
                const dcaThreshold = b.isDiangucMode ? bot.botSettings.diangucdca : bot.botSettings.posdca;
                const nextDCAPrice = b.side === 'LONG' ? b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100))) : b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));
                
                const hitDCA = (b.side === 'LONG' && markP >= nextDCAPrice) || (b.side === 'SHORT' && markP <= nextDCAPrice);
                if (hitDCA && (b.dcaCount + 1) <= bot.botSettings.maxDCA) {
                    let nextMargin = b.isDiangucMode ? (b.firstMargin * bot.botSettings.heSoDianguc) : (b.firstMargin * bot.botSettings.heSoThuong);
                    openPosition(bot, b.symbol, { ...b, dcaCount: b.dcaCount + 1, margin: nextMargin }, b.side);
                }
            } else {
                if (!bot.isProcessingDCA.has(key)) bot.botActivePositions.delete(key);
            }
        }
    } catch (e) {}
    setTimeout(() => priceMonitor(bot), 1000);
}

// =========================================================
// 🔄 VÒNG LẶP QUÉT TÍN HIỆU & THỰC THI "ĐỊA NGỤC ĐÈ THƯỜNG"
// =========================================================
async function processCoreScan(bot) {
    if (!bot.status.isReady || !bot.botSettings.isRunning) return;
    if (bot.botActivePositions.size >= bot.botSettings.maxPositions || bot.isProcessingDCA.size > 0) return;

    let signal = null;
    for (const c of sharedState.candidatesList) {
        const res = checkEntryCondition(c, bot.botSettings, bot.botActivePositions);
        if (res) { signal = res; break; }
    }

    if (signal) {
        const info = sharedState.exchangeInfo[signal.symbol];
        if (!info) return;

        // 🔥 LOGIC LÕI: ĐỊA NGỤC ĐẠT VOL => ĐÓNG MARKET LỆNH THƯỜNG / LỆNH TAY ĐỂ CHẠY ĐỊA NGỤC
        if (signal.isDianguc) {
            for (let [key, posActive] of bot.botActivePositions) {
                if (posActive.symbol === signal.symbol && !posActive.isDiangucMode) {
                    addBotLog(bot, `⚡ PHÁT HIỆN VOL ĐỊA NGỤC: Tiến hành Đóng Market vị thế thường của ${signal.symbol} lập tức!`, "warn");
                    await closePositionAndLog(bot, posActive, posActive.livePrice, "OVERRIDE ĐỊA NGỤC");
                    bot.botActivePositions.delete(key);
                }
            }
        }

        const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
        if (!acc) return;

        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${signal.symbol}`).catch(() => null);
        if (!ticker) return;
        const currentPrice = parseFloat(ticker.data.price);

        let calculatedMargin = bot.botSettings.invValue.toString().includes('%') 
            ? (parseFloat(acc.availableBalance) * parseFloat(bot.botSettings.invValue) / 100)
            : parseFloat(bot.botSettings.invValue);

        const qty = Math.ceil(((calculatedMargin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        openPosition(bot, signal.symbol, null, signal.side, qty, calculatedMargin, currentPrice, signal.isDianguc);
    }
}

// =========================================================
// 📡 ROUTING CÁC EXPRESS SERVERS VÀ PHÂN CHIA PORT ĐỘC LẬP
// =========================================================
const app2401 = express(); app2401.use(express.json());
const app2402 = express(); app2402.use(express.json());
const app2403 = express(); app2403.use(express.json());

async function buildStatusResponse(bot) {
    const acc = await binancePrivate(bot, '/fapi/v2/account').catch(() => null);
    return { 
        botSettings: bot.botSettings, activePositions: Array.from(bot.botActivePositions.values()), status: bot.status, 
        wallet: { totalWalletBalance: acc ? parseFloat(acc.totalMarginBalance).toFixed(2) : "0.00" }
    };
}

// 🌐 PORT 2401 (BOT CHÍNH) - Trả về giao diện Terminal nhúng trực tiếp cực nét
app2401.get('/', (req, res) => res.send(DASHBOARD_HTML));
app2401.get('/api/status', async (req, res) => res.json(await buildStatusResponse(botChinh)));
app2401.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body; const key = `${symbol}_${side}`; const b = botChinh.botActivePositions.get(key);
    if (b) { await closePositionAndLog(botChinh, b, b.livePrice, "UI CẮT THỦ CÔNG"); botChinh.botActivePositions.delete(key); }
    res.json({ success: true });
});
app2401.post('/api/close_all', async (req, res) => {
    for (let [key, b] of botChinh.botActivePositions) { await closePositionAndLog(botChinh, b, b.livePrice, "PANIC CLOSE MARKET"); botChinh.botActivePositions.delete(key); }
    res.json({ success: true });
});

// 🌐 PORT 2402 & 2403 - GIỮ NGUYÊN HOÀN TOÀN CƠ CHẾ DÙNG FILE TĨNH ĐỘC LẬP VÀ ĐƯỜNG DẪN FIXED CHUẨN
app2402.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index2402.html')));
app2402.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot1)));

app2403.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index2403.html')));
app2403.get('/api/status', async (req, res) => res.json(await buildStatusResponse(bot2)));

// Lắng nghe cổng độc lập của từng hệ thống bot
app2401.listen(2401, () => console.log('⚡ Bot Chính Terminal nhúng chạy tại: http://localhost:2401'));
app2402.listen(2402, () => console.log('✅ Bot 1 độc lập chạy tại: http://localhost:2402'));
app2403.listen(2403, () => console.log('✅ Bot 2 độc lập chạy tại: http://localhost:2403'));

// =========================================================
// KẾT NỐI VÀ ĐỒNG BỘ DỮ LIỆU TỪ SERVER TỔNG HỢP (PORT 9000)
// =========================================================
async function initSystem() {
    try {
        await botChinh.exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(botChinh, '/fapi/v1/leverageBracket');
        const temp = {};
        
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return;
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            temp[s.symbol] = {
                quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision,
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev
            };
        });
        
        sharedState.exchangeInfo = temp;
        botChinh.status.isReady = true; bot1.status.isReady = true; bot2.status.isReady = true;
        
        // Khởi động các vòng lặp độc lập dữ liệu
        priceMonitor(botChinh); priceMonitor(bot1); priceMonitor(bot2);
        
        setInterval(() => processCoreScan(botChinh), 2000);
    } catch (e) { setTimeout(initSystem, 5000); }
}
initSystem();

// Sync Dữ liệu liên tục từ port 9000
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', chunk => d += chunk);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);
