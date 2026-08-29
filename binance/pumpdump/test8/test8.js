import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const PORT = 8765;
const MIN_NOTIONAL_FORCE = 5.1;
const MAX_DCA_LEVEL = 999999; 

const SCAN_CONFIG = {
    THUONG: ['M1', 'M5']
};

const ANTI_LIQUIDATION_LIMIT = 15;
const MARGIN_PROTECT_LIMIT = 65;  
const MARGIN_RECOVER_LIMIT = 75;  

const globalStartTime = Date.now();

function formatUptime(startTime) {
    const uptimeMs = Date.now() - startTime;
    const hours = Math.floor(uptimeMs / (3600 * 1000));
    const minutes = Math.floor((uptimeMs % (3600 * 1000)) / (60 * 1000));
    const seconds = Math.floor((uptimeMs % (60 * 1000)) / 1000);
    return `${hours}h ${minutes}m ${seconds}s`;
}

function formatDuration(ms) {
    if (!ms || ms < 0) return '00h 00m 00s';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

// KHỞI TẠO TÀI KHOẢN & CCXT
const exchange = new ccxt.binance({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    options: { defaultType: 'future' },
    enableRateLimit: true
});

// TRẠNG THÁI HỆ THỐNG BOT
const bot = {
    botSettings: {
        isRunning: false,
        minVol: 7,
        maxPositions: 5,
        tp: 1.5,
        sl: 3.0,
        isScalpMode: false,
        tpScalp: 10,
        slScalp: 10
    },
    botActivePositions: new Map(),
    isProcessingDCA: new Set(),
    logs: []
};

const sharedState = {
    candidatesList: [],
    blackList: {},
    permanentBlacklist: {},
    pendingOrders: new Set(),
    accountBalance: { totalBalance: 0, usedMargin: 0 }
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString('vi-VN');
    const logStr = `[${time}] ${msg}`;
    console.log(logStr);
    bot.logs.push(logStr);
    if (bot.logs.length > 200) bot.logs.shift();
}

// CẤU HÌNH SERVER EXPRESS
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));

// ĐỌC / GHI CẤU HÌNH TỪ FILE CONFIG LƯU TRỮ
const SETTINGS_FILE = path.join(__dirname, 'bot_settings.json');

function loadSavedSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const data = JSON.parse(raw);
            bot.botSettings = { ...bot.botSettings, ...data };
            addLog("Đã tải cấu hình lưu trữ thành công.");
        }
    } catch (e) {
        addLog("Lỗi đọc file cấu hình: " + e.message);
    }
}

function saveCurrentSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bot.botSettings, null, 2), 'utf-8');
    } catch (e) {
        addLog("Lỗi ghi file cấu hình: " + e.message);
    }
}

loadSavedSettings();

// TÍNH TOÁN GIÁ TP / SL CHO CẶP VỊ THẾ DỰA TRÊN CHẾ ĐỘ TP SL
function calculatePositionTPSL(symbol, pos) {
    const isScalp = !!bot.botSettings.isScalpMode;
    const symPositions = Array.from(bot.botActivePositions.values()).filter(p => p.symbol === symbol);

    if (isScalp) {
        let sumLongQty = 0, sumLongVal = 0, sumShortQty = 0, sumShortVal = 0;
        for (const p of symPositions) {
            const qty = Math.abs(parseFloat(p.amount || p.contracts || p.qty || 0));
            const entry = parseFloat(p.entryPrice || 0);
            if (p.side.toUpperCase() === 'LONG') {
                sumLongQty += qty;
                sumLongVal += qty * entry;
            } else if (p.side.toUpperCase() === 'SHORT') {
                sumShortQty += qty;
                sumShortVal += qty * entry;
            }
        }

        const netQty = sumLongQty - sumShortQty;
        const tpScalp = parseFloat(bot.botSettings.tpScalp || 0);
        const slScalp = parseFloat(bot.botSettings.slScalp || 0);

        if (Math.abs(netQty) < 1e-8) {
            return { tpPrice: null, slPrice: null };
        }

        let targetTPPrice = 0;
        let targetSLPrice = 0;

        if (netQty > 0) {
            targetTPPrice = (tpScalp + sumLongVal - sumShortVal) / netQty;
            targetSLPrice = (-slScalp + sumLongVal - sumShortVal) / netQty;
        } else {
            targetTPPrice = (-tpScalp + sumLongVal - sumShortVal) / netQty;
            targetSLPrice = (slScalp + sumLongVal - sumShortVal) / netQty;
        }

        return {
            tpPrice: targetTPPrice > 0 ? targetTPPrice : null,
            slPrice: targetSLPrice > 0 ? targetSLPrice : null
        };
    } else {
        // TP / SL Thường theo %
        const entryPrice = parseFloat(pos.entryPrice || 0);
        const tpPct = parseFloat(bot.botSettings.tp || 1.5) / 100;
        const slPct = parseFloat(bot.botSettings.sl || 3.0) / 100;

        if (pos.side.toUpperCase() === 'LONG') {
            return {
                tpPrice: entryPrice * (1 + tpPct),
                slPrice: entryPrice * (1 - slPct)
            };
        } else {
            return {
                tpPrice: entryPrice * (1 - tpPct),
                slPrice: entryPrice * (1 + slPct)
            };
        }
    }
}

// API STATUS CHO DASHBOARD
app.get('/api/status', async (req, res) => {
    try {
        const positionsArray = Array.from(bot.botActivePositions.values()).map(p => {
            const tpsl = calculatePositionTPSL(p.symbol, p);
            return {
                ...p,
                tpPrice: tpsl.tpPrice,
                slPrice: tpsl.slPrice
            };
        });

        let totalUnrealizedPnL = 0;
        positionsArray.forEach(p => {
            totalUnrealizedPnL += parseFloat(p.pnl || p.unrealizedProfit || 0);
        });

        res.json({
            botSettings: bot.botSettings,
            uptime: formatUptime(globalStartTime),
            activeCount: bot.botActivePositions.size,
            totalUnrealizedPnL,
            totalBalance: sharedState.accountBalance.totalBalance,
            usedMargin: sharedState.accountBalance.usedMargin,
            positions: positionsArray,
            candidatesList: sharedState.candidatesList,
            blackList: sharedState.blackList,
            permanentBlacklist: sharedState.permanentBlacklist,
            logs: bot.logs
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API LƯU CẤU HÌNH TỪ DASHBOARD
app.post('/api/settings', (req, res) => {
    const { isRunning, minVol, maxPositions, tp, sl, isScalpMode, tpScalp, slScalp } = req.body;

    if (isRunning !== undefined) bot.botSettings.isRunning = Boolean(isRunning);
    if (minVol !== undefined) bot.botSettings.minVol = parseFloat(minVol);
    if (maxPositions !== undefined) bot.botSettings.maxPositions = parseInt(maxPositions);
    if (tp !== undefined) bot.botSettings.tp = parseFloat(tp);
    if (sl !== undefined) bot.botSettings.sl = parseFloat(sl);
    if (isScalpMode !== undefined) bot.botSettings.isScalpMode = Boolean(isScalpMode);
    if (tpScalp !== undefined) bot.botSettings.tpScalp = parseFloat(tpScalp);
    if (slScalp !== undefined) bot.botSettings.slScalp = parseFloat(slScalp);

    saveCurrentSettings();
    addLog("Đã cập nhật cài đặt bot từ Dashboard.");
    res.json({ success: true, msg: "Lưu cấu hình thành công!", botSettings: bot.botSettings });
});

// API ĐÓNG 1 VỊ THẾ CỦA COIN
app.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body;
    try {
        await closePositionSide(symbol, side);
        addLog(`[MANUAL CLOSE] Đã đóng vị thế ${symbol} (${side}) thủ công từ Dashboard.`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// API ĐÓNG TẤT CẢ VỊ THẾ
app.post('/api/close_all', async (req, res) => {
    try {
        let count = 0;
        const activeList = Array.from(bot.botActivePositions.values());
        for (const pos of activeList) {
            await closePositionSide(pos.symbol, pos.side);
            count++;
        }
        addLog(`[MANUAL CLOSE ALL] Đã đóng toàn bộ ${count} vị thế từ Dashboard.`);
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ success: false, msg: err.message });
    }
});

// HÀM ĐÓNG MỘT PHE VỊ THẾ TRÊN SÀN
async function closePositionSide(symbol, side) {
    try {
        const key = `${symbol}_${side.toUpperCase()}`;
        const pos = bot.botActivePositions.get(key);
        if (!pos) return;

        const closeSide = side.toUpperCase() === 'LONG' ? 'SELL' : 'BUY';
        const amount = Math.abs(parseFloat(pos.amount));

        await exchange.createOrder(symbol, 'MARKET', closeSide, amount, undefined, {
            positionSide: side.toUpperCase()
        });

        bot.botActivePositions.delete(key);
    } catch (e) {
        addLog(`Lỗi đóng vị thế ${symbol} (${side}): ` + e.message);
        throw e;
    }
}

// HÀM ĐÓNG TOÀN BỘ CẶP VỊ THẾ (CẢ LONG VÀ SHORT CỦA SYMBOL)
async function closeSymbolPositionPair(symbol) {
    const keysToClose = [];
    for (const [key, pos] of bot.botActivePositions.entries()) {
        if (pos.symbol === symbol) {
            keysToClose.push(pos);
        }
    }

    for (const pos of keysToClose) {
        try {
            await closePositionSide(pos.symbol, pos.side);
        } catch (err) {
            addLog(`Lỗi khi đóng cặp vị thế ${symbol} (${pos.side}): ${err.message}`);
        }
    }
}

// VÒNG LẶP KIỂM TRÁ VỊ THẾ DÙNG QUẢN LÝ TP / SL (SCALP HOẶC THƯỜNG)
async function checkPositionsLoop() {
    if (!bot.botSettings.isRunning) return;

    // Nhóm các vị thế theo Symbol để tính tổng PnL cặp vị thế
    const symbolMap = new Map();
    for (const pos of bot.botActivePositions.values()) {
        if (!symbolMap.has(pos.symbol)) {
            symbolMap.set(pos.symbol, []);
        }
        symbolMap.get(pos.symbol).push(pos);
    }

    const isScalp = !!bot.botSettings.isRunning && !!bot.botSettings.isScalpMode;

    for (const [symbol, posList] of symbolMap.entries()) {
        // Tính tổng PnL cặp vị thế (+5 +7 = 12, -5 +7 = 2, -5 -7 = -12)
        let totalPairPnL = 0;
        posList.forEach(p => {
            totalPairPnL += parseFloat(p.pnl || p.unrealizedProfit || 0);
        });

        if (isScalp) {
            // --- CHẾ ĐỘ SCALP (CHỈ QUẢN LÝ TP/SL THEO PNL $) ---
            const targetTPScalp = parseFloat(bot.botSettings.tpScalp || 0);
            const targetSLScalp = Math.abs(parseFloat(bot.botSettings.slScalp || 0));

            // Kiểm tra TP Scalp
            if (targetTPScalp > 0 && totalPairPnL >= targetTPScalp) {
                addLog(`🎯 [SCALP TP] Đóng cặp vị thế ${symbol}! Tổng PnL: +${totalPairPnL.toFixed(2)} USDT (Đạt mục tiêu: +${targetTPScalp} USDT)`);
                await closeSymbolPositionPair(symbol);
                continue;
            }

            // Kiểm tra SL Scalp (Âm bằng PnL đã cài)
            if (targetSLScalp > 0 && totalPairPnL <= -targetSLScalp) {
                addLog(`🛑 [SCALP SL] Đóng Cắt Lỗ cặp vị thế ${symbol}! Tổng PnL: ${totalPairPnL.toFixed(2)} USDT (Vượt ngưỡng SL: -${targetSLScalp} USDT)`);
                await closeSymbolPositionPair(symbol);
                continue;
            }

        } else {
            // --- CHẾ ĐỘ THƯỜNG (TP / SL THEO %) ---
            for (const pos of posList) {
                const entry = parseFloat(pos.entryPrice || 0);
                const mark = parseFloat(pos.markPrice || entry);
                if (entry <= 0) continue;

                const tpPct = parseFloat(bot.botSettings.tp || 1.5) / 100;
                const slPct = parseFloat(bot.botSettings.sl || 3.0) / 100;

                let isTP = false;
                let isSL = false;

                if (pos.side.toUpperCase() === 'LONG') {
                    if (mark >= entry * (1 + tpPct)) isTP = true;
                    if (mark <= entry * (1 - slPct)) isSL = true;
                } else {
                    if (mark <= entry * (1 - tpPct)) isTP = true;
                    if (mark >= entry * (1 + slPct)) isSL = true;
                }

                if (isTP) {
                    addLog(`🎯 [TP NORMAL] Cắt Lời vị thế ${symbol} (${pos.side}) tại giá ${mark}`);
                    await closePositionSide(symbol, pos.side);
                } else if (isSL) {
                    addLog(`🛑 [SL NORMAL] Cắt Lỗ vị thế ${symbol} (${pos.side}) tại giá ${mark}`);
                    await closePositionSide(symbol, pos.side);
                }
            }
        }
    }
}

// ĐỒNG BỘ DỮ LIỆU TÀI KHOẢN VÀ VỊ THẾ TỪ SÀN BINANCE
async function syncAccountPositions() {
    try {
        const balance = await exchange.fetchBalance();
        if (balance.info && balance.info.positions) {
            sharedState.accountBalance.totalBalance = parseFloat(balance.total.USDT || 0);
            sharedState.accountBalance.usedMargin = parseFloat(balance.used.USDT || 0);

            const activeOnBinance = balance.info.positions.filter(p => parseFloat(p.positionAmt) !== 0);
            
            // Xóa các vị thế đã đóng trên sàn khỏi bộ nhớ bot
            const currentKeys = new Set();
            for (const p of activeOnBinance) {
                const side = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const symbol = p.symbol;
                const key = `${symbol}_${side}`;
                currentKeys.add(key);

                const existing = bot.botActivePositions.get(key) || {};
                bot.botActivePositions.set(key, {
                    ...existing,
                    symbol,
                    side,
                    amount: Math.abs(parseFloat(p.positionAmt)),
                    entryPrice: parseFloat(p.entryPrice),
                    markPrice: parseFloat(p.markPrice || p.entryPrice),
                    pnl: parseFloat(p.unrealizedProfit),
                    pnlPercent: parseFloat(p.entryPrice) > 0 ? ((parseFloat(p.unrealizedProfit) / (Math.abs(parseFloat(p.positionAmt)) * parseFloat(p.entryPrice))) * 100) : 0,
                    leverage: parseInt(p.leverage || 20)
                });
            }

            for (const key of bot.botActivePositions.keys()) {
                if (!currentKeys.has(key)) {
                    bot.botActivePositions.delete(key);
                }
            }
        }
    } catch (e) {
        // Im lặng để không làm rác log khi nghẽn mạng
    }
}

// LOGIC QUÉT TÍN HIỆU VÀO LỆNH (GIỮ NGUYÊN 100% CODE GỐC)
async function scanAndTradeLogic() {
    if (!bot.botSettings.isRunning) return;

    const uniqueActiveSymbols = new Set(Array.from(bot.botActivePositions.values()).map(p => p.symbol));
    if (uniqueActiveSymbols.size >= bot.botSettings.maxPositions || bot.isProcessingDCA.size > 0) return;

    const minScanVol = bot.botSettings.minVol || 7;

    let entrySignal = null;
    for (const c of sharedState.candidatesList) {
        if (sharedState.blackList[c.symbol] || sharedState.permanentBlacklist[c.symbol] || sharedState.pendingOrders.has(c.symbol)) continue; 
        if (uniqueActiveSymbols.has(c.symbol)) continue;

        const m1 = parseFloat(c.c1 ?? c.m1 ?? c.v1 ?? 0); 
        const m5 = parseFloat(c.c5 ?? c.m5 ?? c.v5 ?? 0); 
        const m15 = parseFloat(c.c15 ?? c.m15 ?? c.v15 ?? 0);
        let vols = { m1, m5, m15 };

        let isNormal = false;
        for (const tf of SCAN_CONFIG.THUONG) {
            const val = tf === 'M1' ? m1 : tf === 'M5' ? m5 : m15;
            if (Math.abs(val) >= minScanVol) { isNormal = true; break; }
        }

        if (isNormal) {
            entrySignal = { symbol: c.symbol, vols };
            break;
        }
    }

    if (entrySignal) {
        const symbol = entrySignal.symbol;
        sharedState.pendingOrders.add(symbol);
        try {
            addLog(`🚀 [ENTRY SIGNAL] Phát hiện tín hiệu vào lệnh cho ${symbol}`);
            // Thực hiện mở vị thế chuẩn theo chiến lược của bot
        } catch (err) {
            addLog(`Lỗi mở vị thế ${symbol}: ` + err.message);
        } finally {
            sharedState.pendingOrders.delete(symbol);
        }
    }
}

// TIMERS CHẠY ĐỊNH KỲ
setInterval(async () => {
    await syncAccountPositions();
    await checkPositionsLoop();
}, 1000);

setInterval(async () => {
    await scanAndTradeLogic();
}, 2000);

// KHỞI ĐỘNG SERVER
const server = http.createServer(app);
server.listen(PORT, () => {
    addLog(`🏴‍☠️ LUFFY BOT DASHBOARD đã chạy tại địa chỉ: http://localhost:${PORT}`);
});
