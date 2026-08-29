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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(__dirname));

const bot = {
    botSettings: {
        isRunning: false,
        maxPositions: 3,
        minVol: 7,
        dcaPercent: 1.5,
        tpPercent: 1.0,
        slPercent: 5.0,
        isScalpMode: false,
        tpScalp: 5.0,
        slScalp: 5.0
    },
    botActivePositions: new Map(),
    isProcessingDCA: new Set(),
    logs: []
};

const sharedState = {
    candidatesList: [],
    blackList: {},
    permanentBlacklist: {},
    pendingOrders: new Set()
};

function logMessage(msg) {
    const timeStr = new Date().toLocaleTimeString('vi-VN');
    const fullLog = `[${timeStr}] ${msg}`;
    console.log(fullLog);
    bot.logs.unshift(fullLog);
    if (bot.logs.length > 200) bot.logs.pop();
}

const exchange = new ccxt.binanceusdm({
    apiKey: API_KEY,
    secret: SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

async function closeSymbolPositions(symbol) {
    try {
        const positions = Array.from(bot.botActivePositions.values()).filter(p => p.symbol === symbol);
        for (const pos of positions) {
            const side = pos.side;
            const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
            const qty = Math.abs(parseFloat(pos.positionAmt));
            
            await exchange.createOrder(symbol, 'MARKET', closeSide, qty, undefined, {
                reduceOnly: true
            });
            logMessage(`✅ Đã đóng vị thế SCALP ${symbol} (${side}) khối lượng: ${qty}`);
            bot.botActivePositions.delete(`${symbol}_${side}`);
        }
    } catch (e) {
        logMessage(`❌ Lỗi đóng vị thế SCALP ${symbol}: ${e.message}`);
    }
}

async function checkAndExecuteTPSL() {
    if (bot.botActivePositions.size === 0) return;

    if (bot.botSettings.isScalpMode) {
        const groupedSymbols = new Set(Array.from(bot.botActivePositions.values()).map(p => p.symbol));

        for (const symbol of groupedSymbols) {
            const positions = Array.from(bot.botActivePositions.values()).filter(p => p.symbol === symbol);
            let totalPnl = 0;

            for (const pos of positions) {
                totalPnl += parseFloat(pos.unrealizedPnl || pos.pnl || 0);
            }

            const tpScalp = Math.abs(parseFloat(bot.botSettings.tpScalp) || 0);
            const slScalp = Math.abs(parseFloat(bot.botSettings.slScalp) || 0);

            if (tpScalp > 0 && totalPnl >= tpScalp) {
                logMessage(`🎯 [SCALP TP] Cặp ${symbol} đạt Tổng PnL: ${totalPnl.toFixed(2)} USDT >= ${tpScalp} USDT. Tiến hành đóng cặp!`);
                await closeSymbolPositions(symbol);
            } else if (slScalp > 0 && totalPnl <= -slScalp) {
                logMessage(`🛑 [SCALP SL] Cặp ${symbol} âm Tổng PnL: ${totalPnl.toFixed(2)} USDT <= -${slScalp} USDT. Tiến hành đóng cặp!`);
                await closeSymbolPositions(symbol);
            }
        }
    } else {
        for (const [key, pos] of bot.botActivePositions.entries()) {
            const entry = parseFloat(pos.entryPrice);
            const mark = parseFloat(pos.markPrice);
            const side = pos.side;
            const tpPct = parseFloat(bot.botSettings.tpPercent) / 100;
            const slPct = parseFloat(bot.botSettings.slPercent) / 100;

            let currentPnlPct = 0;
            if (side === 'LONG') {
                currentPnlPct = (mark - entry) / entry;
            } else {
                currentPnlPct = (entry - mark) / entry;
            }

            if (tpPct > 0 && currentPnlPct >= tpPct) {
                logMessage(`🎯 [PERCENT TP] ${pos.symbol} (${side}) đạt PnL ${(currentPnlPct * 100).toFixed(2)}% >= ${bot.botSettings.tpPercent}%. Đóng lệnh!`);
                await closeSymbolPositions(pos.symbol);
            } else if (slPct > 0 && currentPnlPct <= -slPct) {
                logMessage(`🛑 [PERCENT SL] ${pos.symbol} (${side}) chạm PnL ${(currentPnlPct * 100).toFixed(2)}% <= -${bot.botSettings.slPercent}%. Đóng lệnh!`);
                await closeSymbolPositions(pos.symbol);
            }
        }
    }
}

async function updatePositionsState() {
    try {
        const res = await exchange.fapiPrivateV2GetPositionRisk();
        const activeMap = new Map();

        for (const p of res) {
            const amt = parseFloat(p.positionAmt);
            if (amt !== 0) {
                const symbol = p.symbol;
                const side = amt > 0 ? 'LONG' : 'SHORT';
                const key = `${symbol}_${side}`;
                const entryPrice = parseFloat(p.entryPrice);
                const markPrice = parseFloat(p.markPrice);
                const unrealizedPnl = parseFloat(p.unRealizedProfit);

                activeMap.set(key, {
                    symbol,
                    side,
                    positionAmt: amt,
                    entryPrice,
                    markPrice,
                    unrealizedPnl,
                    leverage: p.leverage,
                    liquidationPrice: parseFloat(p.liquidationPrice)
                });
            }
        }
        bot.botActivePositions = activeMap;
        await checkAndExecuteTPSL();
    } catch (e) {
        logMessage(`⚠️ Lỗi cập nhật vị thế: ${e.message}`);
    }
}

app.get('/api/status', (req, res) => {
    const formattedPositions = [];
    const isScalp = bot.botSettings.isScalpMode;

    const groupedBySymbol = new Map();
    for (const pos of bot.botActivePositions.values()) {
        if (!groupedBySymbol.has(pos.symbol)) {
            groupedBySymbol.set(pos.symbol, []);
        }
        groupedBySymbol.get(pos.symbol).push(pos);
    }

    for (const [symbol, positions] of groupedBySymbol.entries()) {
        let totalPnlForSymbol = 0;
        let longQty = 0, longEntry = 0;
        let shortQty = 0, shortEntry = 0;

        for (const p of positions) {
            totalPnlForSymbol += p.unrealizedPnl;
            const q = Math.abs(p.positionAmt);
            if (p.side === 'LONG') {
                longQty += q;
                longEntry = p.entryPrice;
            } else {
                shortQty += q;
                shortEntry = p.entryPrice;
            }
        }

        const deltaQty = longQty - shortQty;
        const tpScalpVal = Math.abs(parseFloat(bot.botSettings.tpScalp) || 0);
        const slScalpVal = Math.abs(parseFloat(bot.botSettings.slScalp) || 0);

        for (const pos of positions) {
            let tpPrice = 0;
            let slPrice = 0;

            if (isScalp) {
                if (Math.abs(deltaQty) > 0.00000001) {
                    tpPrice = (tpScalpVal + longEntry * longQty - shortEntry * shortQty) / deltaQty;
                    slPrice = (-slScalpVal + longEntry * longQty - shortEntry * shortQty) / deltaQty;
                    if (tpPrice < 0) tpPrice = 0;
                    if (slPrice < 0) slPrice = 0;
                } else {
                    tpPrice = 0;
                    slPrice = 0;
                }
            } else {
                const entry = pos.entryPrice;
                const tpPct = parseFloat(bot.botSettings.tpPercent) / 100;
                const slPct = parseFloat(bot.botSettings.slPercent) / 100;

                if (pos.side === 'LONG') {
                    tpPrice = entry * (1 + tpPct);
                    slPrice = entry * (1 - slPct);
                } else {
                    tpPrice = entry * (1 - tpPct);
                    slPrice = entry * (1 + slPct);
                }
            }

            formattedPositions.push({
                ...pos,
                pnl: pos.unrealizedPnl,
                tpPrice,
                slPrice,
                symbolTotalPnl: totalPnlForSymbol
            });
        }
    }

    res.json({
        uptime: formatUptime(globalStartTime),
        botSettings: bot.botSettings,
        positions: formattedPositions,
        logs: bot.logs,
        candidates: sharedState.candidatesList
    });
});

app.post('/api/settings', (req, res) => {
    try {
        const { isRunning, maxPositions, minVol, dcaPercent, tpPercent, slPercent, isScalpMode, tpScalp, slScalp } = req.body;

        if (isRunning !== undefined) bot.botSettings.isRunning = Boolean(isRunning);
        if (maxPositions !== undefined) bot.botSettings.maxPositions = Number(maxPositions);
        if (minVol !== undefined) bot.botSettings.minVol = Number(minVol);
        if (dcaPercent !== undefined) bot.botSettings.dcaPercent = Number(dcaPercent);
        if (tpPercent !== undefined) bot.botSettings.tpPercent = Number(tpPercent);
        if (slPercent !== undefined) bot.botSettings.slPercent = Number(slPercent);
        if (isScalpMode !== undefined) bot.botSettings.isScalpMode = Boolean(isScalpMode);
        if (tpScalp !== undefined) bot.botSettings.tpScalp = Number(tpScalp);
        if (slScalp !== undefined) bot.botSettings.slScalp = Number(slScalp);

        logMessage(`⚙️ Cập nhật cấu hình: ScalpMode=${bot.botSettings.isScalpMode}, TPScalp=${bot.botSettings.tpScalp}, SLScalp=${bot.botSettings.slScalp}`);
        res.json({ success: true, botSettings: bot.botSettings });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/api/close_position', async (req, res) => {
    try {
        const { symbol, side } = req.body;
        const key = `${symbol}_${side}`;
        const pos = bot.botActivePositions.get(key);

        if (!pos) {
            return res.json({ success: false, msg: 'Không tìm thấy vị thế' });
        }

        const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
        const qty = Math.abs(parseFloat(pos.positionAmt));

        await exchange.createOrder(symbol, 'MARKET', closeSide, qty, undefined, { reduceOnly: true });
        bot.botActivePositions.delete(key);
        logMessage(`🖐️ Thủ công đóng vị thế ${symbol} (${side})`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

app.post('/api/close_all', async (req, res) => {
    try {
        let count = 0;
        for (const pos of bot.botActivePositions.values()) {
            const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
            const qty = Math.abs(parseFloat(pos.positionAmt));
            await exchange.createOrder(pos.symbol, 'MARKET', closeSide, qty, undefined, { reduceOnly: true });
            count++;
        }
        bot.botActivePositions.clear();
        logMessage(`⚠️ Đóng TOÀN BỘ ${count} vị thế thủ công!`);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ success: false, msg: e.message });
    }
});

async function checkSignalAndOpen() {
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
        logMessage(`⚡ Tìm thấy tín hiệu hợp lệ: ${entrySignal.symbol}`);
    }
}

setInterval(updatePositionsState, 1500);
setInterval(checkSignalAndOpen, 3000);

server.listen(PORT, () => {
    console.log(`LUFFY BOT DASHBOARD running at http://localhost:${PORT}`);
});
