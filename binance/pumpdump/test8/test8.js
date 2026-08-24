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
    const hStr = hours.toString().padStart(2, '0');
    const mStr = minutes.toString().padStart(2, '0');
    const sStr = seconds.toString().padStart(2, '0');
    return `${hStr}h ${mStr}s ${sStr}s`;
}

function formatCoinName(symbol) {
    return `<span style="color: #f97316; font-weight: bold;">${symbol}</span>`;
}

let walletCache = { data: { totalWalletBalance: "0", totalMarginBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" }, lastUpdate: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

const POSITIONS_FILE = path.join(__dirname, 'positions.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });

let sharedState = {
    blackList: {},
    permanentBlacklist: {},
    candidatesList: [],
    exchangeInfo: null,
    masterLogs: [],
    errorSpamGuard: {}, 
    pendingOrders: new Set(),
    lastClosedMargin: {}
};

function parseNormalizedSettings(reqBody, currentSettings) {
    const normalized = { ...currentSettings };
    for (let key in reqBody) {
        const val = reqBody[key];
        const lowerKey = key.toLowerCase();
        if (['maxpnlpausepct', 'maxpnlresumepct', 'minvol', 'possl', 'posdcaam', 'posdcaduong', 'hesodcaam', 'hesodcaduong', 'tpdcaam', 'tpdcaduong', 'minpnltpdcaduong'].includes(lowerKey)) {
            normalized[key] = parseFloat(val);
        } else if (['maxpositions', 'mindcaduongcount'].includes(lowerKey)) {
            normalized[key] = parseInt(val);
        } else if (lowerKey === 'enableearlysl') {
            const boolVal = val === true || val === 'true' || val === 1 || val === '1';
            normalized.enableEarlySL = boolVal;
            normalized[key] = boolVal;
        } else {
            normalized[key] = val; 
        }
    }
    return normalized;
}

let bot = {
    id: "LUFFY_BOT",
    startTime: Date.now(),
    botSettings: {
        isRunning: false,
        enableEarlySL: false,
        invValue: "1%",
        maxPositions: 3,
        minVol: 7,
        posSL: 10.0,
        posDcaAm: 3.0,
        posDcaDuong: 3.0,
        heSoDcaAm: 2.0,
        heSoDcaDuong: 2.0,
        tpDcaAm: 10.0,
        tpDcaDuong: 10.0,
        minDcaDuongCount: 10,
        minPnlTpDcaDuong: 10.0,
        maxPnlPausePct: 5.0,
        maxPnlResumePct: 2.5
    },
    status: { botLogs: [], botClosedCount: 0, botPnLClosed: 0, pnlGain: 0, pnlLoss: 0, isReady: false },
    botActivePositions: new Map(),
    isProcessingDCA: new Set(),
    logThrottle: new Map(),
    timestampOffset: 0,
    isMarginProtected: false,
    isAntiLiquidationTriggered: false,
    isPnlPaused: false,
    exchange: new ccxt.binance({ apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } }),
    binanceApi: axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } })
};

function calculateDcaDuongMargin(botInst, b) {
    const oppositeSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
    const oppKey = `${b.symbol}_${oppositeSide}`;
    const oppPos = botInst.botActivePositions.get(oppKey);
    
    let oppMargin = 0;
    if (oppPos) {
        oppMargin = oppPos.currentMargin || oppPos.firstMargin || 0;
    } else {
        oppMargin = sharedState.lastClosedMargin[oppKey] || b.firstMargin || 0;
    }
    
    if (!oppMargin || oppMargin <= 0) {
        oppMargin = b.firstMargin || 1;
    }

    const heSo = botInst.botSettings.heSoDcaDuong || 2.0;
    return oppMargin * heSo;
}

function calculateDcaAmMargin(botInst, b) {
    const heSo = botInst.botSettings.heSoDcaAm || 2.0;
    return (b.firstMargin || 1) * heSo;
}

function calculateTpDcaDuongDetails(botInst, b) {
    const posDcaDuongPct = botInst.botSettings.posDcaDuong || 3.0;
    const heSoDcaDuong = botInst.botSettings.heSoDcaDuong || 2.0;
    const tpDcaDuongPct = botInst.botSettings.tpDcaDuong || 10.0;
    const minDcaCount = botInst.botSettings.minDcaDuongCount !== undefined ? botInst.botSettings.minDcaDuongCount : 10;
    const minPnlTp = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
    const dir = b.side === 'LONG' ? 1 : -1;
    const info = sharedState.exchangeInfo ? sharedState.exchangeInfo[b.symbol] : null;
    const lev = b.leverage || info?.maxLeverage || 20;

    let targetTpPrice = 0;
    let estPnl = 0;
    const currentDcaCount = b.dcaDuongCount || 0;

    if (currentDcaCount >= minDcaCount) {
        const peak = b.peakPrice || b.firstEntry;
        targetTpPrice = peak * (1 - dir * (tpDcaDuongPct / 100));
        estPnl = dir * (targetTpPrice - b.avgEntry) * b.currentQty;
    } else {
        let simCount = currentDcaCount;
        let simAvgEntry = b.avgEntry || b.firstEntry;
        let simCumQty = b.currentQty || 0;
        let simCumCost = simAvgEntry * simCumQty;
        let simMargin = b.currentMargin || b.firstMargin || 1;

        while (simCount < minDcaCount) {
            simCount++;
            let nextPrice = simAvgEntry * (1 + dir * (posDcaDuongPct / 100));
            let addedMargin = simMargin * heSoDcaDuong;
            let addedQty = (addedMargin * lev) / nextPrice;
            simCumQty += addedQty;
            simCumCost += addedQty * nextPrice;
            simAvgEntry = simCumCost / simCumQty;
            simMargin += addedMargin;
        }

        let simPeak = simAvgEntry;
        targetTpPrice = simPeak * (1 - dir * (tpDcaDuongPct / 100));
        estPnl = dir * (targetTpPrice - simAvgEntry) * simCumQty;
    }

    let badge = "";
    const remainingRed = Math.max(0, minDcaCount - currentDcaCount);

    if (remainingRed > 0) {
        badge = "❌".repeat(remainingRed);
    } else {
        badge = "✅";
        const currentPnl = b.pnl || 0;
        if (currentPnl < minPnlTp || estPnl < minPnlTp) {
            badge += ' <span style="color: #a855f7; font-weight: bold;" title="Chưa đủ PnL chốt tối thiểu">❌</span>';
        }
    }

    return { targetTpPrice, estPnl, badge };
}

function calculateTpDcaAmDetails(botInst, b) {
    const tpDcaAmPct = botInst.botSettings.tpDcaAm || 10.0;
    const dir = b.side === 'LONG' ? 1 : -1;
    const targetTpPrice = b.avgEntry + dir * (b.firstEntry * (tpDcaAmPct / 100));
    const estPnl = dir * (targetTpPrice - b.avgEntry) * b.currentQty;
    return { targetTpPrice, estPnl };
}

function calculateSlDetails(botInst, b) {
    const slPct = botInst.botSettings.posSL || 10.0;
    const dir = b.side === 'LONG' ? 1 : -1;
    const targetSlPrice = b.firstEntry * (1 - dir * (slPct / 100));
    const estPnl = dir * (targetSlPrice - b.avgEntry) * b.currentQty;
    return { targetSlPrice, estPnl };
}

function calculateSlPhongHoDetails(botInst, b) {
    if (b.side === 'LONG') {
        return { formattedStr: '--' };
    }
    const slPrice = b.firstEntry * 2.01;
    const estPnl = -1 * (slPrice - b.avgEntry) * b.currentQty;
    const info = sharedState.exchangeInfo ? sharedState.exchangeInfo[b.symbol] : null;
    const pPrec = info ? info.pricePrecision : 4;
    return { 
        slPrice, 
        estPnl, 
        formattedStr: `${slPrice.toFixed(pPrec)} (${estPnl.toFixed(2)}$)` 
    };
}

let positionRiskCache = { data: null, lastUpdate: 0 };

async function getCachedPositionRisk(botInst, maxAgeMs = 300) {
    const now = Date.now();
    if (positionRiskCache.data && (now - positionRiskCache.lastUpdate < maxAgeMs)) {
        return positionRiskCache.data;
    }
    try {
        const data = await binancePrivate(botInst, '/fapi/v2/positionRisk');
        if (Array.isArray(data)) {
            positionRiskCache.data = data;
            positionRiskCache.lastUpdate = now;
            return data;
        }
    } catch (e) {
        if (positionRiskCache.data) return positionRiskCache.data;
    }
    return null;
}

let tickerCache = { data: {}, lastUpdate: 0 };
async function getCachedTickerPrice(symbol, maxAgeMs = 300) {
    const now = Date.now();
    if (tickerCache.data[symbol] && (now - tickerCache.data[symbol].lastUpdate < maxAgeMs)) {
        return tickerCache.data[symbol].price;
    }
    try {
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const price = parseFloat(ticker.data.price);
        tickerCache.data[symbol] = { price, lastUpdate: now };
        return price;
    } catch (e) {
        if (tickerCache.data[symbol]) return tickerCache.data[symbol].price;
        throw e;
    }
}

const leverageSetCache = new Set();
async function setLeverageIfNeeded(botInst, symbol, maxLeverage) {
    const key = `${botInst.id}_${symbol}_${maxLeverage}`;
    if (leverageSetCache.has(key)) return;
    try {
        await botInst.exchange.setLeverage(maxLeverage, symbol);
        leverageSetCache.add(key);
    } catch (e) { }
}

function savePositionsToFile() {
    try {
        const data = Array.from(bot.botActivePositions.entries());
        fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error("Lỗi khi ghi vị thế vào position.json:", e.message);
    }
}

function loadPositionsFromFile() {
    try {
        if (!fs.existsSync(POSITIONS_FILE)) return;
        const raw = fs.readFileSync(POSITIONS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            bot.botActivePositions = new Map(data);
        }
    } catch (e) {
        console.error("Lỗi khi đọc vị thế từ position.json:", e.message);
    }
}

function saveSettingsToFile() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(bot.botSettings, null, 2), 'utf-8');
    } catch (e) {}
}

function loadSettingsFromFile() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return;
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (data) bot.botSettings = parseNormalizedSettings(data, bot.botSettings);
    } catch (e) {}
}

function addBotLog(botInst, msg, type = 'open', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = botInst.logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        botInst.logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const logItem = { time, msg, type, botId: botInst.id };
    
    botInst.status.botLogs.unshift(logItem);
    if (botInst.status.botLogs.length > 200) botInst.status.botLogs.pop();
    
    sharedState.masterLogs.unshift({ time, msg: `[${botInst.id}] ${msg}`, type });
    if (sharedState.masterLogs.length > 400) sharedState.masterLogs.pop();
    
    const consoleMsg = msg.replace(/<[^>]*>/g, '');
    console.log(`[${time}][${botInst.id}][${type.toUpperCase()}] ${consoleMsg}`);
}

async function binancePrivate(botInst, endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + botInst.timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await botInst.binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            botInst.timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(botInst, endpoint, method, data);
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in sharedState.blackList) {
        if (now > sharedState.blackList[symbol]) delete sharedState.blackList[symbol];
    }
}, 2000);

function checkAndAddBlacklist(symbol) {
    const hasPos = bot.botActivePositions.has(`${symbol}_LONG`) || bot.botActivePositions.has(`${symbol}_SHORT`);
    if (!hasPos) {
        sharedState.blackList[symbol] = Date.now() + (15 * 60 * 1000); 
    }
}

const closeQueue = [];
let isProcessingCloseQueue = false;

async function processCloseQueue() {
    if (isProcessingCloseQueue) return;
    isProcessingCloseQueue = true;

    while (closeQueue.length > 0) {
        const task = closeQueue.shift();
        try {
            await task();
        } catch (e) {
            console.error("Lỗi khi xử lý hàng chờ đóng vị thế:", e.message);
        }
        if (closeQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    isProcessingCloseQueue = false;
}

function queueClosePosition(botInst, b, markP, reasonStr) {
    const key = `${b.symbol}_${b.side}`;
    if (b.isClosing) return;
    b.isClosing = true;

    closeQueue.push(async () => {
        try {
            const success = await executeClosePositionAndLog(botInst, b, markP, reasonStr);
            if (success) {
                botInst.botActivePositions.delete(key);
                savePositionsToFile();
                checkAndAddBlacklist(b.symbol);
            } else {
                b.isClosing = false;
            }
        } catch (e) {
            b.isClosing = false;
        }
    });

    processCloseQueue();
}

async function executeClosePositionAndLog(botInst, b, markP, reasonStr) {
    const info = sharedState.exchangeInfo[b.symbol];
    const pPrec = info ? info.pricePrecision : 6; 
    let finalPnL = 0;
    let orderClosedSuccessfully = false;

    sharedState.lastClosedMargin[`${b.symbol}_${b.side}`] = b.currentMargin || b.firstMargin;

    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const realP = posRisk.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
        
        if (realP) {
            const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
            const closeQty = Math.min(b.currentQty || exchangeQty, exchangeQty);
            try {
                await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', closeQty, undefined, { positionSide: b.side });
                orderClosedSuccessfully = true;
            } catch (err) {
                const errMsg = err?.response?.data?.msg || err?.message || String(err);
                if (errMsg.includes('2022') || errMsg.includes('ReduceOnly Order would be rejected')) {
                    orderClosedSuccessfully = true;
                } else {
                    addBotLog(botInst, `⚠️ Lỗi gửi lệnh Market đóng ${formatCoinName(b.symbol)}: ${errMsg}`, "warn");
                    return false;
                }
            }
        } else {
            orderClosedSuccessfully = true;
        }
    } catch (e) {
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(botInst, `❌ Thất bại khi đóng vị thế sàn ${formatCoinName(b.symbol)}: ${errMsg}`, "error");
        return false;
    }
    
    if (!orderClosedSuccessfully) return false;

    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
        const recheckPos = await binancePrivate(botInst, '/fapi/v2/positionRisk').catch(() => []);
        const stillOpen = recheckPos.find(p => p.symbol === b.symbol && p.positionSide === b.side && Math.abs(parseFloat(p.positionAmt)) > 0);
        if (stillOpen) {
            addBotLog(botInst, `⚠️ [CHECK NGẦM 3S] Vị thế ${formatCoinName(b.symbol)} ${b.side} vẫn tồn tại trên sàn! Đang thực hiện đóng lại ngay...`, "warn");
            const forceQty = Math.abs(parseFloat(stillOpen.positionAmt));
            await botInst.exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', forceQty, undefined, { positionSide: b.side }).catch(()=>{});
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    } catch (recheckErr) { }

    try {
        const trades = await binancePrivate(botInst, '/fapi/v1/userTrades', 'GET', { symbol: b.symbol, limit: 12 }).catch(() => []);
        const nowServer = Date.now() + botInst.timestampOffset;
        const matchingTrades = trades.filter(t => t.positionSide === b.side && (nowServer - t.time) < 35000);
        
        const estFee = (b.currentQty * markP * 0.0005 * 2); 

        if (matchingTrades.length > 0) {
            finalPnL = matchingTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl) - parseFloat(t.commission || 0), 0);
        } else {
            let pnlRaw = b.side === 'LONG' ? (markP - b.avgEntry) * b.currentQty : (b.avgEntry - markP) * b.currentQty;
            finalPnL = pnlRaw - estFee;
        }

        botInst.status.botClosedCount++;
        botInst.status.botPnLClosed += finalPnL;

        if (finalPnL >= 0) {
            botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
        } else {
            botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
        }

        let isExplicitTP = reasonStr.includes("TP") || reasonStr.includes("TRAILING");
        let isExplicitSL = reasonStr.includes("SL") || reasonStr.includes("CẮT LỖ");

        let logType = "tp";
        let detailTag = "CHỐT LÃI TP";

        if (isExplicitSL || (!isExplicitTP && finalPnL < 0)) {
            logType = "sl";
            detailTag = "CẮT LỖ SL";
        } else if (isExplicitTP && finalPnL < 0) {
            logType = "warn";
            detailTag = "CHỐT TP SÀN/NỘI BỘ (ÂM PNL DO PHÍ)";
        }

        const formattedSymbol = formatCoinName(b.symbol);
        addBotLog(botInst, `🔒 [${detailTag} | LÝ DO: ${reasonStr}] ${formattedSymbol} ${b.side} | Giá chốt: ${markP.toFixed(pPrec)} | Net PnL: ${finalPnL.toFixed(2)}$`, logType);
        
    } catch (e) {
        const errMsg = e?.response?.data?.msg || e?.message || String(e);
        addBotLog(botInst, `❌ Lỗi xử lý/ghi log PnL cho ${formatCoinName(b.symbol)}: ${errMsg}`, "error");
    }

    try {
        const openOrders = await binancePrivate(botInst, '/fapi/v1/openOrders', 'GET', { symbol: b.symbol }).catch(() => []);
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate(botInst, '/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {}

    return true;
}

async function panicCloseAll(botInst, reasonLog) {
    try {
        const posRisk = await getCachedPositionRisk(botInst, 0) || [];
        const active = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        if (active.length === 0 && botInst.botActivePositions.size === 0) {
            return { success: true, count: 0 };
        }
        let count = 0;
        for (const p of active) {
            const side = p.positionSide;
            const qty = Math.abs(parseFloat(p.positionAmt));
            const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
            const key = `${p.symbol}_${side}`;
            try {
                await botInst.exchange.createOrder(p.symbol, 'MARKET', sideClose, qty, undefined, { positionSide: side });
                count++;
                
                const b = botInst.botActivePositions.get(key);
                if (b) {
                    let pnlRaw = parseFloat(p.unRealizedProfit || 0);
                    const feeVolDeduction = (qty * parseFloat(p.markPrice) * 0.0005);
                    let finalPnL = pnlRaw - feeVolDeduction;

                    botInst.status.botClosedCount++;
                    botInst.status.botPnLClosed += finalPnL;
                    if (finalPnL >= 0) {
                        botInst.status.pnlGain = (botInst.status.pnlGain || 0) + finalPnL;
                    } else {
                        botInst.status.pnlLoss = (botInst.status.pnlLoss || 0) + finalPnL;
                    }
                }
            } catch (err) { }
        }
        botInst.botActivePositions.clear();
        savePositionsToFile();
        addBotLog(botInst, `⚠️ [KÍCH HOẠT ĐÓNG TOÀN BỘ] Đã giải phóng tài khoản (${reasonLog}).`, "warn");
        return { success: true, count };
    } catch (e) { return { success: false, msg: e.message }; }
}

async function priceMonitor(botInst) {
    if (!botInst.status.isReady) return setTimeout(() => priceMonitor(botInst), 300);
    try {
        if (!botInst.botSettings.isRunning) return setTimeout(() => priceMonitor(botInst), 300);
        
        const posRisk = await getCachedPositionRisk(botInst, 300);
        if (!posRisk || !Array.isArray(posRisk)) {
            return setTimeout(() => priceMonitor(botInst), 300);
        }

        const now = Date.now();
        
        for (let [key, b] of Array.from(botInst.botActivePositions.entries())) {
            if (b.isClosing) continue;

            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            if (realP) {
                const exchangeQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);

                b.currentQty = exchangeQty;
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.livePrice = markP;

                const currentAvgEntry = b.avgEntry || parseFloat(realP.entryPrice) || b.firstEntry;
                b.avgEntry = currentAvgEntry;

                if (b.side === 'LONG') {
                    b.peakPrice = Math.max(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((markP - currentAvgEntry) / currentAvgEntry) * 100;
                } else {
                    b.peakPrice = Math.min(b.peakPrice || b.firstEntry, markP);
                    b.profitPercent = ((currentAvgEntry - markP) / currentAvgEntry) * 100;
                }

                const currentDcaMode = b.pnl < 0 ? 'AM' : 'DUONG';
                b.dcaType = currentDcaMode;

                const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
                const posDcaDuong = botInst.botSettings.posDcaDuong || 3.0;
                const tpDcaAmPct = botInst.botSettings.tpDcaAm || 10.0;
                const tpDcaDuongPct = botInst.botSettings.tpDcaDuong || 10.0;
                const dir = (b.side === 'LONG' ? 1 : -1);

                b.nextDcaAm = currentAvgEntry * (1 - dir * ((b.dcaAmCount + 1) * posDcaAm / 100));
                b.nextDcaDuong = currentAvgEntry * (1 + dir * (posDcaDuong / 100));

                savePositionsToFile();

                // 0. KIỂM TRA CHẾ ĐỘ CẮT LỖ SỚM (DCA DƯƠNG >= 1 VÀ GIÁ TỤT VỀ AVG ENTRY +- 0.7% GIÁ ENTRY ĐẦU)
                if (botInst.botSettings.enableEarlySL && (b.dcaDuongCount || 0) >= 1) {
                    const earlySlTarget = b.side === 'LONG' 
                        ? (currentAvgEntry + (b.firstEntry * 0.007))
                        : (currentAvgEntry - (b.firstEntry * 0.007));

                    const hitEarlySl = b.side === 'LONG' ? (markP <= earlySlTarget) : (markP >= earlySlTarget);
                    if (hitEarlySl) {
                        const oppSide = b.side === 'LONG' ? 'SHORT' : 'LONG';
                        const oppKey = `${b.symbol}_${oppSide}`;
                        const oppPos = botInst.botActivePositions.get(oppKey);

                        queueClosePosition(botInst, b, markP, `CẮT LỖ SỚM DCA DƯƠNG CHẠM AVG ENTRY ${b.side === 'LONG' ? '+' : '-'} 0.7% ENTRY ĐẦU (${earlySlTarget.toFixed(4)})`);
                        if (oppPos && !oppPos.isClosing) {
                            queueClosePosition(botInst, oppPos, oppPos.livePrice || markP, `CẮT LỖ SỚM THEO CẶP (${b.symbol})`);
                        }
                        continue;
                    }
                }

                // 1. KIỂM TRA CHỐT LÃI TP DCA ÂM
                if (currentDcaMode === 'AM') {
                    const targetTpPrice = currentAvgEntry + dir * (b.firstEntry * (tpDcaAmPct / 100));
                    const hitInternalTP = b.side === 'LONG' ? (markP >= targetTpPrice) : (markP <= targetTpPrice);
                    if (hitInternalTP && b.pnl > 0) {
                        queueClosePosition(botInst, b, markP, "CHỐT TP DCA ÂM");
                        continue;
                    }

                    if (b.side === 'SHORT') {
                        const slPhongHoPrice = b.firstEntry * 2.01;
                        if (markP >= slPhongHoPrice) {
                            queueClosePosition(botInst, b, markP, `CẮT LỖ SL PHÒNG HỘ 101% ENTRY (${slPhongHoPrice.toFixed(4)})`);
                            continue;
                        }
                    }
                }

                // 2. KIỂM TRA CHỐT LÃI TP DCA DƯƠNG
                if (currentDcaMode === 'DUONG') {
                    const dropThreshold = b.firstEntry * (tpDcaDuongPct / 100);
                    const minDcaCount = botInst.botSettings.minDcaDuongCount !== undefined ? botInst.botSettings.minDcaDuongCount : 10;
                    const minPnlTp = botInst.botSettings.minPnlTpDcaDuong !== undefined ? botInst.botSettings.minPnlTpDcaDuong : 10.0;
                    const isUnlocked = (b.dcaDuongCount || 0) >= minDcaCount;

                    if (b.side === 'LONG') {
                        const reachedPeakMin = b.peakPrice >= b.firstEntry * (1 + (tpDcaDuongPct / 100));
                        if (reachedPeakMin && markP <= (b.peakPrice - dropThreshold) && b.pnl > 0) {
                            if (isUnlocked && b.pnl >= minPnlTp) {
                                queueClosePosition(botInst, b, markP, `CHỐT TP DCA DƯƠNG (Peak: ${b.peakPrice.toFixed(4)}, Tụt ${tpDcaDuongPct}% từ đỉnh, PnL: ${b.pnl.toFixed(2)}$ >= ${minPnlTp}$)`);
                                continue;
                            }
                        }
                    } else {
                        const reachedPeakMin = b.peakPrice <= b.firstEntry * (1 - (tpDcaDuongPct / 100));
                        if (reachedPeakMin && markP >= (b.peakPrice + dropThreshold) && b.pnl > 0) {
                            if (isUnlocked && b.pnl >= minPnlTp) {
                                queueClosePosition(botInst, b, markP, `CHỐT TP DCA DƯƠNG (Peak Low: ${b.peakPrice.toFixed(4)}, Tăng ${tpDcaDuongPct}% từ đáy, PnL: ${b.pnl.toFixed(2)}$ >= ${minPnlTp}$)`);
                                continue;
                            }
                        }
                    }
                }

                // 3. KIỂM TRA CẮT LỖ SL NỘI BỘ
                const hitInternalSL = b.side === 'LONG' ? (markP <= b.sl) : (markP >= b.sl);
                if (hitInternalSL) {
                    queueClosePosition(botInst, b, markP, "CẮT LỖ SL NỘI BỘ");
                    continue;
                }

                const isDcaCooldown = b.lastDcaTime && (now - b.lastDcaTime < 8000);
                if (isDcaCooldown) continue;

                // 4. KÍCH HOẠT NHỒI LỆNH DCA ÂM (BẮT BUỘC PNL ÂM VÀ GIÁ DƯỚI AGV)
                if (b.pnl < 0 && markP < currentAvgEntry) {
                    const hitDcaAm = b.side === 'LONG' ? (markP <= b.nextDcaAm) : (markP >= b.nextDcaAm);
                    if (hitDcaAm && !botInst.isProcessingDCA.has(lockKey)) {
                        botInst.isProcessingDCA.add(lockKey);
                        let marginToUse = calculateDcaAmMargin(botInst, b);
                        openPosition(botInst, b.symbol, { ...b, dcaType: 'AM', margin: marginToUse }, b.side);
                        continue;
                    }
                }

                // 5. KÍCH HOẠT NHỒI LỆNH DCA DƯƠNG (BẮT BUỘC PNL DƯƠNG VÀ GIÁ VƯỢT MỐC DCA DƯƠNG)
                const isDcaDuongValid = b.side === 'LONG' ? (markP > currentAvgEntry) : (markP < currentAvgEntry);
                if (b.pnl > 0 && isDcaDuongValid) {
                    const hitDcaDuong = b.side === 'LONG' ? (markP >= b.nextDcaDuong) : (markP <= b.nextDcaDuong);
                    if (hitDcaDuong && !botInst.isProcessingDCA.has(lockKey)) {
                        botInst.isProcessingDCA.add(lockKey);
                        let marginToUse = calculateDcaDuongMargin(botInst, b);
                        openPosition(botInst, b.symbol, { ...b, dcaType: 'DUONG', margin: marginToUse }, b.side);
                        continue;
                    }
                }
            } else {
                if (!botInst.isProcessingDCA.has(lockKey)) {
                    botInst.botActivePositions.delete(key); 
                    savePositionsToFile();
                    checkAndAddBlacklist(b.symbol);
                }
            }
        }
    } catch (e) { }
    
    setTimeout(() => priceMonitor(botInst), 300);
}

async function openPosition(botInst, symbol, dcaData = null, forcedSide = 'LONG', sharedQty = null, sharedMargin = null, sharedPrice = null, signalVols = null) {
    const side = forcedSide; 
    const isDCA = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (botInst.isProcessingDCA.has(lockKey) && !isDCA) return;
    botInst.isProcessingDCA.add(lockKey); 

    try {
        const info = sharedState.exchangeInfo[symbol];
        if (!info) throw new Error("Coin không hỗ trợ");
        const pPrec = info.pricePrecision; 

        let qty = 0, margin = 0, currentPrice = 0;
        const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

        if (isDCA) {
            currentPrice = await getCachedTickerPrice(symbol, 300);
            margin = dcaData.margin;
            let desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
            if (qty * currentPrice < actualMinNotional) {
                qty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
            }
            qty = Number(qty.toFixed(info.quantityPrecision)); 
        } else {
            qty = sharedQty;
            margin = sharedMargin;
            currentPrice = sharedPrice;
        }

        try {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            const availBal = parseFloat(acc?.availableBalance || 0);
            const reqMargin = (qty * currentPrice) / info.maxLeverage;
            if (availBal > 0 && reqMargin > availBal * 0.95) {
                const safeMargin = availBal * 0.90;
                let adjQty = (safeMargin * info.maxLeverage) / currentPrice;
                adjQty = Math.floor(adjQty / info.stepSize) * info.stepSize;
                adjQty = Number(adjQty.toFixed(info.quantityPrecision));
                if (adjQty * currentPrice >= actualMinNotional) {
                    qty = adjQty;
                } else {
                    addBotLog(botInst, `⚠️ [BỎ QUA LỆNH] Số dư khả dụng không đủ (${availBal.toFixed(2)}$ < Margin ${reqMargin.toFixed(2)}$) - Tránh lỗi 2019`, "warn");
                    return;
                }
            }
        } catch (chkErr) {}

        await setLeverageIfNeeded(botInst, symbol, info.maxLeverage);
        
        let order = null;
        try {
            order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        } catch (orderErr) {
            const errMsg = orderErr?.response?.data?.msg || orderErr?.message || String(orderErr);
            if (errMsg.includes('2019') || orderErr?.response?.data?.code === -2019) {
                addBotLog(botInst, `⚠️ Lỗi 2019 (Ký quỹ không đủ) cho ${formatCoinName(symbol)} ${side}. Đang giảm 20% volume để gửi lại...`, "warn");
                qty = Math.floor((qty * 0.8) / info.stepSize) * info.stepSize;
                qty = Number(qty.toFixed(info.quantityPrecision));
                if (qty * currentPrice >= actualMinNotional) {
                    order = await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
                } else {
                    addBotLog(botInst, `❌ Ký quỹ quá nhỏ không đủ mở lệnh ${formatCoinName(symbol)} sau khi điều chỉnh.`, "error");
                    return;
                }
            } else {
                throw orderErr;
            }
        }
        
        if (order) {
            await new Promise(resolve => setTimeout(resolve, 3000));

            let actualFilledPrice = currentPrice;
            let realP = null;
            try {
                let posRisk = await binancePrivate(botInst, '/fapi/v2/positionRisk').catch(() => []);
                realP = posRisk.find(p => p.symbol === symbol && p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
                
                if (!realP) {
                    addBotLog(botInst, `⚠️ [CHECK NGẦM 3S] Mở lệnh ${formatCoinName(symbol)} ${side} báo thành công nhưng trên sàn chưa ghi nhận! Đang thực hiện mở lại...`, "warn");
                    await botInst.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side }).catch(()=>{});
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    posRisk = await binancePrivate(botInst, '/fapi/v2/positionRisk').catch(() => []);
                    realP = posRisk.find(p => p.symbol === symbol && p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);
                }

                if (realP && parseFloat(realP.entryPrice) > 0) {
                    actualFilledPrice = parseFloat(realP.entryPrice);
                } else if (order.average || order.price || parseFloat(order.info?.avgPrice)) {
                    actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice);
                }
            } catch (err) {
                actualFilledPrice = order.average || order.price || parseFloat(order.info?.avgPrice) || currentPrice;
            }

            let cumulativeQty = qty;
            let cumulativeCost = qty * actualFilledPrice;
            let newAvgEntry = actualFilledPrice;
            let actualMarginUsed = (qty * actualFilledPrice) / info.maxLeverage;
            let totalMargin = actualMarginUsed;
            let dcaHistory = [];
            let dcaAmCount = 0;
            let dcaDuongCount = 0;
            let lastDcaType = 'DUONG';

            if (isDCA) {
                cumulativeQty = dcaData.cumulativeQty + qty;
                cumulativeCost = dcaData.cumulativeCost + (qty * actualFilledPrice);
                newAvgEntry = cumulativeCost / cumulativeQty;
                totalMargin = dcaData.currentMargin + actualMarginUsed;
                dcaHistory = [...dcaData.dcaHistory, { price: actualFilledPrice, margin: actualMarginUsed, type: dcaData.dcaType }];
                dcaAmCount = dcaData.dcaType === 'AM' ? dcaData.dcaAmCount + 1 : dcaData.dcaAmCount;
                dcaDuongCount = dcaData.dcaType === 'DUONG' ? dcaData.dcaDuongCount + 1 : dcaData.dcaDuongCount;
                lastDcaType = dcaData.dcaType;
            } else {
                dcaHistory = [{ price: actualFilledPrice, margin: actualMarginUsed, type: 'ENTRY' }];
                lastDcaType = 'DUONG';
            }

            const firstE = dcaData ? dcaData.firstEntry : newAvgEntry;
            const posDcaAm = botInst.botSettings.posDcaAm || 3.0;
            const posDcaDuong = botInst.botSettings.posDcaDuong || 3.0;
            const slPercent = botInst.botSettings.posSL || 10.0;
            const tpDcaAmPercent = botInst.botSettings.tpDcaAm || 10.0;

            const dir = (side === 'LONG' ? 1 : -1);

            let nextDcaAm = newAvgEntry * (1 - dir * ((dcaAmCount + 1) * posDcaAm / 100));
            let nextDcaDuong = newAvgEntry * (1 + dir * (posDcaDuong / 100));

            let finalTP = newAvgEntry + dir * (firstE * (tpDcaAmPercent / 100));
            let finalSL = firstE * (1 - dir * (slPercent / 100));

            const nowTime = Date.now();
            
            const posData = { 
                symbol, side, entryPrice: firstE, tp: finalTP, sl: finalSL, 
                dcaAmCount, dcaDuongCount, dcaCount: dcaAmCount + dcaDuongCount, 
                dcaType: lastDcaType, lastDcaType,
                leverage: info.maxLeverage, firstEntry: firstE, firstMargin: isDCA ? dcaData.firstMargin : totalMargin, 
                currentMargin: totalMargin, currentQty: cumulativeQty, 
                cumulativeQty: cumulativeQty, cumulativeCost: cumulativeCost, dcaHistory: dcaHistory,
                pnl: 0, profitPercent: 0, peakPrice: isDCA ? Math.max(dcaData.peakPrice || firstE, actualFilledPrice) : actualFilledPrice,
                avgEntry: newAvgEntry, nextDcaAm, nextDcaDuong, livePrice: actualFilledPrice,
                createdAt: dcaData ? (dcaData.createdAt || nowTime) : nowTime,
                lastActionTime: nowTime, 
                lastDcaTime: nowTime,
                time: dcaData ? (dcaData.time || new Date().toLocaleTimeString('vi-VN', { hour12: false })) : new Date().toLocaleTimeString('vi-VN', { hour12: false })
            };

            botInst.botActivePositions.set(lockKey, posData);
            savePositionsToFile();

            const formattedSymbol = formatCoinName(symbol);
            if (!isDCA) {
                let volStr = signalVols ? ` | M1: ${signalVols.m1} M5: ${signalVols.m5} M15: ${signalVols.m15}` : '';
                const logStr = `[MỞ ${side}] ${formattedSymbol} | Margin: ${totalMargin.toFixed(2)}$ | Entry: ${newAvgEntry.toFixed(pPrec)}${volStr} | DCA Âm Kế: ${nextDcaAm.toFixed(pPrec)} | DCA Dương Kế: ${nextDcaDuong.toFixed(pPrec)}`;
                addBotLog(botInst, logStr, "open"); 
            } else {
                const historyPricesStr = dcaHistory.map(h => `${h.type === 'DUONG' ? '+' : '-'}${h.price.toFixed(pPrec)}`).join(' ➔ ');
                const logStr = `[DCA ${dcaData.dcaType}] ${formattedSymbol} ${side} | Margin DCA: ${actualMarginUsed.toFixed(2)}$ | Vốn: ${totalMargin.toFixed(2)}$ | Âm:${dcaAmCount} Dương:${dcaDuongCount} | Chuỗi: [ ${historyPricesStr} ] | Avg Mới: ${newAvgEntry.toFixed(pPrec)}`;
                addBotLog(botInst, logStr, "dca"); 
            }
        }
    } catch (e) { 
        const errKey = `${symbol}_${e.message}`;
        const now = Date.now();
        const errMsgDetails = e?.response?.data?.msg || e?.stack || e?.message || String(e);
        if (!sharedState.errorSpamGuard[errKey] || now - sharedState.errorSpamGuard[errKey] > 3600000) { 
            sharedState.errorSpamGuard[errKey] = now;
            addBotLog(botInst, `❌ [LỖI MỞ LỆNH] ${formatCoinName(symbol)}: ${errMsgDetails}`, "error"); 
        }
        checkAndAddBlacklist(symbol);
    } finally { 
        setTimeout(() => {
            botInst.isProcessingDCA.delete(lockKey);
        }, 1000); 
        sharedState.pendingOrders.delete(symbol);
    }
}

async function openPositionPair(botInst, symbol, signalVols = null) {
    const info = sharedState.exchangeInfo[symbol];
    if (!info) return;

    const currentPrice = await getCachedTickerPrice(symbol, 300).catch(() => null);
    if (!currentPrice) return;

    const actualMinNotional = Math.max(MIN_NOTIONAL_FORCE, info.minNotional || MIN_NOTIONAL_FORCE);

    const calcParams = async () => {
        const now = Date.now();
        if (!walletCache.data || walletCache.data.availableBalance === "0" || (now - walletCache.lastUpdate > 5000)) {
            const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
            if (acc) {
                walletCache.data = { 
                    totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                    totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                    availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                    totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
                };
                walletCache.lastUpdate = now;
            }
        }
        if (!walletCache.data) return null;

        const snapshotAvailable = parseFloat(walletCache.data.availableBalance || 0);
        const marginSetting = botInst.botSettings.invValue || "1%";
        let calculatedMargin = marginSetting.toString().includes('%') ? (snapshotAvailable * parseFloat(marginSetting) / 100) : parseFloat(marginSetting);

        let desiredQty = (calculatedMargin * info.maxLeverage) / currentPrice;
        let finalQty = Math.floor(desiredQty / info.stepSize) * info.stepSize;
        if (finalQty * currentPrice < actualMinNotional) {
            finalQty = Math.ceil((actualMinNotional / currentPrice) / info.stepSize) * info.stepSize;
        }
        finalQty = Number(finalQty.toFixed(info.quantityPrecision));
        const finalMargin = (finalQty * currentPrice) / info.maxLeverage;
        return { finalQty, finalMargin };
    };

    const p = await calcParams();
    if (!p) return;

    addBotLog(botInst, `🚀 KÍCH HOẠT MỞ CẶP VỊ THẾ LONG & SHORT: ${formatCoinName(symbol)}`, "open");

    await openPosition(botInst, symbol, null, 'LONG', p.finalQty, p.finalMargin, currentPrice, signalVols);
    await new Promise(r => setTimeout(r, 800));
    await openPosition(botInst, symbol, null, 'SHORT', p.finalQty, p.finalMargin, currentPrice, signalVols);
}

async function checkPnlPauseStatus(botInst, walletData) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return;
    const totalWallet = parseFloat(walletData.totalWalletBalance || 0);
    const totalUnl = parseFloat(walletData.totalUnrealizedProfit || 0);
    
    if (totalWallet <= 0) return;
    
    const pnlRatio = (totalUnl / totalWallet) * 100; 
    const maxPause = botInst.botSettings.maxPnlPausePct || 5.0;
    const maxResume = botInst.botSettings.maxPnlResumePct || 2.5;

    if (!botInst.isPnlPaused && pnlRatio <= -maxPause) {
        botInst.isPnlPaused = true;
        addBotLog(botInst, `🛑 [CẢNH BÁO PNL ÂM] PnL âm ${pnlRatio.toFixed(2)}% (vượt mốc -${maxPause}%). TẠM DỪNG QUÉT LỆNH MỚI!`, "warn");
    } else if (botInst.isPnlPaused && pnlRatio >= -maxResume) {
        botInst.isPnlPaused = false;
        addBotLog(botInst, `✅ [PHỤC HỒI PNL] PnL hồi về ${pnlRatio.toFixed(2)}% (trên mốc -${maxResume}%). KHÔI PHỤC QUÉT LỆNH MỚI!`, "open");
    }
}

async function checkMarginLimits(botInst) {
    if (!botInst.status.isReady || !botInst.botSettings.isRunning) return;
    const now = Date.now();

    if (!walletCache.data || (now - walletCache.lastUpdate > 3000)) {
        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
            walletCache.lastUpdate = now;
        }
    }

    if (walletCache.data && parseFloat(walletCache.data.totalMarginBalance) > 0) {
        const availPercent = (parseFloat(walletCache.data.availableBalance) / parseFloat(walletCache.data.totalMarginBalance)) * 100;
        
        if (availPercent <= ANTI_LIQUIDATION_LIMIT) { 
            if (!botInst.isAntiLiquidationTriggered) {
                botInst.isAntiLiquidationTriggered = true;
                await panicCloseAll(botInst, `CHỐNG THANH LÝ ${ANTI_LIQUIDATION_LIMIT}%`); 
                botInst.isMarginProtected = false; 
            }
            return; 
        } else {
            botInst.isAntiLiquidationTriggered = false;
        }

        if (!botInst.isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) {
            botInst.isMarginProtected = true; addBotLog(botInst, `⚠️ CẢNH BÁO: Khả dụng giảm dưới ${MARGIN_PROTECT_LIMIT}%. Dừng quét lệnh mới!`, "warn");
        } else if (botInst.isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) {
            botInst.isMarginProtected = false; addBotLog(botInst, `✅ Khả dụng phục hồi trên ${MARGIN_RECOVER_LIMIT}%. Mở lại quét lệnh.`, "open");
        }
    }
}

function allowCors(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

const appServer = express(); 
appServer.use(allowCors); 
appServer.use(express.json()); 
appServer.use(express.static(__dirname, { index: false })); 

appServer.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

async function buildStatusResponse(botInst) {
    const now = Date.now();
    if (now - walletCache.lastUpdate > 3000) {
        const acc = await binancePrivate(botInst, '/fapi/v2/account').catch(() => null);
        if (acc) {
            walletCache.data = { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance || 0).toFixed(2), 
                totalMarginBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2),
                availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
            };
            walletCache.lastUpdate = now;
        }
    }

    await checkPnlPauseStatus(botInst, walletCache.data);

    const posRisk = await getCachedPositionRisk(botInst, 300) || [];
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(sharedState.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) formattedBlacklist[sym] = remainingSecs;
    }

    let unrealizedPnL = 0;
    botInst.botActivePositions.forEach(p => { unrealizedPnL += (p.pnl || 0); });

    const sortedPositions = Array.from(botInst.botActivePositions.values())
        .map(p => {
            const info = sharedState.exchangeInfo ? sharedState.exchangeInfo[p.symbol] : null;
            const pPrec = info ? info.pricePrecision : 4;
            const openDurationMs = now - (p.createdAt || now);
            
            const slDet = calculateSlDetails(botInst, p);
            const slPhongHoDet = calculateSlPhongHoDetails(botInst, p);
            
            let tpDet = null;
            if (p.pnl < 0) {
                tpDet = calculateTpDcaAmDetails(botInst, p);
            } else {
                tpDet = calculateTpDcaDuongDetails(botInst, p);
            }

            return {
                ...p,
                openDurationStr: formatDuration(openDurationMs),
                tpCalculatedPrice: tpDet.targetTpPrice ? tpDet.targetTpPrice.toFixed(pPrec) : '-',
                tpEstimatedPnL: tpDet.estPnl !== undefined ? (tpDet.estPnl >= 0 ? `+${tpDet.estPnl.toFixed(2)}$` : `${tpDet.estPnl.toFixed(2)}$`) : '-',
                dcaDuongBadgeIcon: tpDet.badge || '',
                slCalculatedPrice: slDet.targetSlPrice ? slDet.targetSlPrice.toFixed(pPrec) : '-',
                slEstimatedPnL: slDet.estPnl !== undefined ? `${slDet.estPnl.toFixed(2)}$` : '-',
                slPhongHoFormatted: slPhongHoDet.formattedStr
            };
        })
        .sort((a, b) => (a.pnl || 0) - (b.pnl || 0));

    const exchangePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => {
        const amt = Math.abs(parseFloat(p.positionAmt));
        const entryPrice = parseFloat(p.entryPrice || 0);
        const leverage = parseFloat(p.leverage || 1) || 1;
        const margin = (amt * entryPrice) / leverage;
        return {
            ...p,
            margin: margin.toFixed(2)
        };
    });

    return { 
        botSettings: botInst.botSettings, 
        activePositions: sortedPositions, 
        exchangePositions: exchangePositions, 
        status: { 
            botLogs: botInst.status.botLogs, 
            botClosedCount: botInst.status.botClosedCount, 
            botPnLClosed: botInst.status.botPnLClosed, 
            pnlGain: botInst.status.pnlGain || 0, 
            pnlLoss: botInst.status.pnlLoss || 0, 
            isReady: botInst.status.isReady, 
            isPnlPaused: botInst.isPnlPaused,
            candidatesList: sharedState.candidatesList, 
            blackList: formattedBlacklist, 
            permanentBlacklist: sharedState.permanentBlacklist, 
            exchangeInfo: sharedState.exchangeInfo, 
            timeRun: formatUptime(botInst.startTime) 
        }, 
        wallet: {
            ...walletCache.data,
            unrealizedPnL: unrealizedPnL.toFixed(2)
        }, 
        timeRun: formatUptime(botInst.startTime)
    };
}

appServer.post('/api/settings', (req, res) => {
    bot.botSettings = parseNormalizedSettings(req.body, bot.botSettings);
    saveSettingsToFile();
    res.json({ success: true, msg: "Cập nhật cấu hình thành công!" });
});

appServer.get('/api/status', async (req, res) => {
    const data = await buildStatusResponse(bot);
    res.json(data);
});

appServer.post('/api/close_all', async (req, res) => res.json(await panicCloseAll(bot, "ĐÓNG TOÀN BỘ TỪ DASHBOARD")));

appServer.post('/api/close_position', async (req, res) => { 
    const { symbol, side } = req.body; 
    const key = `${symbol}_${side}`; 
    const b = bot.botActivePositions.get(key); 
    if (b) { 
        queueClosePosition(bot, b, b.livePrice, "ĐÓNG THỦ CÔNG TỪ DASHBOARD");
        return res.json({ success: true }); 
    } else { 
        try { 
            const posRisk = await getCachedPositionRisk(bot, 0) || []; 
            const p = posRisk.find(x => x.symbol === symbol && x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0); 
            if (p) await bot.exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'BUY' : 'SELL', Math.abs(parseFloat(p.positionAmt)), undefined, { positionSide: side }); 
            res.json({ success: true }); 
        } catch (e) { res.json({ success: false, msg: e.message }); } 
    } 
});

function adoptOrphanPosition(targetBot, realP) {
    const symbol = realP.symbol;
    const side = realP.positionSide || (parseFloat(realP.positionAmt) > 0 ? 'LONG' : 'SHORT');
    const key = `${symbol}_${side}`;
    const qty = Math.abs(parseFloat(realP.positionAmt));
    const entryPrice = parseFloat(realP.entryPrice);
    const leverage = parseInt(realP.leverage) || 20;
    const pnl = parseFloat(realP.unRealizedProfit || 0);

    const initialDcaType = pnl < 0 ? 'AM' : 'DUONG';

    const posDcaAm = targetBot.botSettings.posDcaAm || 3.0;
    const posDcaDuong = targetBot.botSettings.posDcaDuong || 3.0;
    const slPercent = targetBot.botSettings.posSL || 10.0;
    const tpDcaAmPercent = targetBot.botSettings.tpDcaAm || 10.0;
    const tpDcaDuongPercent = targetBot.botSettings.tpDcaDuong || 10.0;

    const dir = (side === 'LONG' ? 1 : -1);
    let nextDcaAm = entryPrice * (1 - dir * (posDcaAm / 100));
    let nextDcaDuong = entryPrice * (1 + dir * (posDcaDuong / 100));
    
    let activeTpPercent = initialDcaType === 'AM' ? tpDcaAmPercent : tpDcaDuongPercent;
    let finalTP = entryPrice + dir * (entryPrice * (activeTpPercent / 100));
    let finalSL = entryPrice * (1 - dir * (slPercent / 100));

    const nowTime = Date.now();
    const totalMargin = (qty * entryPrice) / leverage;

    targetBot.botActivePositions.set(key, {
        symbol,
        side,
        entryPrice: entryPrice,
        tp: finalTP,
        sl: finalSL,
        dcaAmCount: initialDcaType === 'AM' ? 1 : 0,
        dcaDuongCount: initialDcaType === 'DUONG' ? 1 : 0,
        dcaCount: 1,
        dcaType: initialDcaType,
        lastDcaType: initialDcaType,
        leverage: leverage,
        firstEntry: entryPrice,
        firstMargin: totalMargin,
        currentMargin: totalMargin,
        currentQty: qty,
        cumulativeQty: qty,
        cumulativeCost: qty * entryPrice,
        dcaHistory: [{ price: entryPrice, margin: totalMargin, type: initialDcaType }],
        pnl: pnl,
        profitPercent: 0,
        peakPrice: entryPrice,
        avgEntry: entryPrice,
        nextDcaAm,
        nextDcaDuong,
        livePrice: parseFloat(realP.markPrice || entryPrice),
        createdAt: nowTime,
        lastActionTime: nowTime,
        lastDcaTime: nowTime,
        time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
    });

    savePositionsToFile();

    const formattedSymbol = formatCoinName(symbol);
    addBotLog(targetBot, `📥 [TIẾP QUẢN VỊ THẾ SÀN] Khôi phục vị thế ${formattedSymbol} ${side} | Type: DCA ${initialDcaType} | Qty: ${qty} | Entry: ${entryPrice} | PnL: ${pnl.toFixed(2)}$`, "warn");
}

async function syncPositionsWithExchange() {
    try {
        const posRisk = await binancePrivate(bot, '/fapi/v2/positionRisk').catch(() => null);
        if (!posRisk || !Array.isArray(posRisk)) return;

        const realActivePositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        const activeKeysOnExchange = new Set(realActivePositions.map(p => `${p.symbol}_${p.positionSide}`));

        for (let [key, pos] of Array.from(bot.botActivePositions.entries())) {
            if (!activeKeysOnExchange.has(key)) {
                bot.botActivePositions.delete(key);
            } else {
                const realP = realActivePositions.find(p => `${p.symbol}_${p.positionSide}` === key);
                if (realP) {
                    pos.avgEntry = parseFloat(realP.entryPrice) || pos.avgEntry || pos.firstEntry;
                    pos.livePrice = parseFloat(realP.markPrice);
                    pos.currentQty = Math.abs(parseFloat(realP.positionAmt));
                    pos.pnl = parseFloat(realP.unRealizedProfit);
                }
            }
        }

        for (const p of realActivePositions) {
            const key = `${p.symbol}_${p.positionSide}`;
            if (!bot.botActivePositions.has(key) && !bot.isProcessingDCA.has(key)) {
                adoptOrphanPosition(bot, p);
            }
        }

        savePositionsToFile();
    } catch (e) {
        console.error("Lỗi đồng bộ vị thế:", e.message);
    }
}

async function init() {
    try {
        await bot.exchange.loadMarkets(); 
        
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate(bot, '/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol); 
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { sharedState.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), minNotional: parseFloat(s.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 5.0), maxLeverage: maxLev };
        });
        sharedState.exchangeInfo = temp; 
        
        loadSettingsFromFile();
        loadPositionsFromFile();

        await syncPositionsWithExchange();

        await new Promise(r => setTimeout(r, 1500));
        bot.status.isReady = true; 
        
        priceMonitor(bot); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(async () => {
    if (bot.status.isReady) {
        await syncPositionsWithExchange();
    }
}, 5000);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { sharedState.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1000);

setInterval(async () => {
    await checkMarginLimits(bot);
    if (!bot.status.isReady || !bot.botSettings.isRunning || bot.isMarginProtected || bot.isPnlPaused) return;

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
        if (sharedState.pendingOrders.has(symbol)) return;
        
        sharedState.pendingOrders.add(symbol);
        setTimeout(() => sharedState.pendingOrders.delete(symbol), 8000); 

        await openPositionPair(bot, symbol, entrySignal.vols);
    }
}, 800);

appServer.listen(PORT, () => console.log(`🚀 [LUFFY BOT] Đã chạy trên Port ${PORT}`));
