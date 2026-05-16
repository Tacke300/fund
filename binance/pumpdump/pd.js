import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs'; 
import WebSocket from 'ws';
import { API_KEY, SECRET_KEY } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE_PATH = path.join(__dirname, 'bot_state_persistent.json');

const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 5000, 
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } 
});

// Object cấu hình gốc - Set mặc định maxDCA = 3 theo yêu cầu vị thế
let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1", 
    minVol: 6.5, 
    posTP: 1.2, 
    posSL: 10.0, 
    maxDCA: 3 
};

// Object status chứa các thông số đếm để mapping chuẩn với file HTML của ông
let status = { 
    botLogs: [], 
    candidatesList: [], 
    blackList: {}, 
    exchangeInfo: {}, 
    isReady: false, 
    isHedgeMode: true,
    botClosedCount: 0,      // Khớp map HTML d.status.botClosedCount
    botPnLClosed: 0.00      // Khớp map HTML d.status.botPnLClosed
};

let botActivePositions = new Map(); 
let openingSymbols = new Set();     
let symbolMutexes = new Map();      
let serverTimeOffset = 0;
let listenKey = null;
let userWsInstance = null;
let markWsInstance = null;
let lastUserWsTime = Date.now();
let lastMarkWsTime = Date.now();
const leverageCache = new Set();    

function getPrecision(stepSize) {
    const step = stepSize.toString();
    if (!step.includes('.')) return 0;
    return step.split('.')[1].replace(/0+$/, '').length;
}

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 30) status.botLogs.pop(); 
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

function saveBotStateToDisk() {
    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify({
            botActivePositions: Array.from(botActivePositions.entries()),
            blackList: status.blackList,
            botSettings,
            botClosedCount: status.botClosedCount,
            botPnLClosed: status.botPnLClosed
        }, null, 2), 'utf8');
    } catch (e) {}
}

function runLocked(symbol, asyncTask) {
    if (!symbolMutexes.has(symbol)) symbolMutexes.set(symbol, Promise.resolve());
    const nextPromise = symbolMutexes.get(symbol).then(async () => {
        try { await asyncTask(); } catch (e) {}
    });
    symbolMutexes.set(symbol, nextPromise);
    return nextPromise;
}

let lastRequestTime = Date.now();
async function binanceRequest(method, endpoint, data = {}) {
    const now = Date.now();
    if (now - lastRequestTime < 30) await new Promise(r => setTimeout(r, 30 - (now - lastRequestTime)));
    lastRequestTime = Date.now();

    const timestamp = Date.now() + serverTimeOffset;
    const mergedData = { ...data, timestamp, recvWindow: 5000 };
    const queryForSign = new URLSearchParams(mergedData).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(queryForSign).digest('hex');

    try {
        const response = await binanceApi({ method, url: `${endpoint}?${queryForSign}&signature=${signature}` });
        return response.data;
    } catch (e) {
        let errorPayload = e.response?.data || { message: e.message, code: 'NETWORK_ERROR' };
        if (typeof errorPayload === 'string' && (errorPayload.includes('<!DOCTYPE html>') || errorPayload.includes('<html>'))) {
            errorPayload = { code: -9999, msg: "HTML Error" };
        }
        if (errorPayload.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            serverTimeOffset = t.data.serverTime - Date.now();
            return binanceRequest(method, endpoint, data);
        }
        const errInstance = new Error(errorPayload.msg || JSON.stringify(errorPayload));
        errInstance.raw = errorPayload;
        throw errInstance;
    }
}

async function initWebSocketEngine() {
    try {
        if (userWsInstance) { try { userWsInstance.terminate(); } catch(e){} }
        const res = await binanceRequest('POST', '/fapi/v1/listenKey');
        listenKey = res.listenKey;

        userWsInstance = new WebSocket(`wss://fstream.binance.com/ws/${listenKey}`);
        lastUserWsTime = Date.now();
        userWsInstance.on('message', (rawData) => {
            lastUserWsTime = Date.now();
            try { handleUserDataEvent(JSON.parse(rawData)); } catch (e) {}
        });
        userWsInstance.on('close', () => setTimeout(initWebSocketEngine, 2000));

        if (markWsInstance) { try { markWsInstance.terminate(); } catch(e){} }
        markWsInstance = new WebSocket(`wss://fstream.binance.com/ws/!markPrice@arr`);
        lastMarkWsTime = Date.now();
        markWsInstance.on('message', (rawData) => {
            lastMarkWsTime = Date.now();
            try { handleGlobalMarkPriceEvent(JSON.parse(rawData)); } catch (e) {}
        });
        markWsInstance.on('close', () => setTimeout(initWebSocketEngine, 2000));
    } catch (e) {
        setTimeout(initWebSocketEngine, 3000);
    }
}

setInterval(() => {
    if (!status.isReady) return;
    const now = Date.now();
    if (now - lastUserWsTime > 15000 || now - lastMarkWsTime > 15000) {
        lastUserWsTime = now; lastMarkWsTime = now;
        initWebSocketEngine();
    }
}, 5000);

setInterval(async () => {
    if (listenKey) await binanceRequest('PUT', '/fapi/v1/listenKey').catch(() => initWebSocketEngine());
}, 20 * 60 * 1000);

function handleUserDataEvent(e) {
    if (e.e === 'ACCOUNT_UPDATE') {
        for (const p of e.a.P) {
            const key = `${p.s}_${p.ps}`;
            if (botActivePositions.has(key)) {
                const b = botActivePositions.get(key);
                if (Math.abs(parseFloat(p.pa)) === 0) executePositionClosureAccounting(p.s, p.ps, key, b);
            }
        }
    }
}

function handleGlobalMarkPriceEvent(dataArr) {
    if (!status.isReady || !botSettings.isRunning) return; 
    const activeSymbols = new Set(Array.from(botActivePositions.values()).map(p => p.symbol));

    for (let i = 0; i < dataArr.length; i++) {
        const item = dataArr[i];
        if (!activeSymbols.has(item.s)) continue;
        const markP = parseFloat(item.p);
        if (botActivePositions.has(`${item.s}_LONG`)) checkAndTriggerMarketClose(`${item.s}_LONG`, markP);
        if (botActivePositions.has(`${item.s}_SHORT`)) checkAndTriggerMarketClose(`${item.s}_SHORT`, markP);
    }
}

function checkAndTriggerMarketClose(key, markP) {
    const b = botActivePositions.get(key);
    if (!b || b.isClosing) return; 

    if (b.side === 'LONG') {
        b.pnl = (markP - b.entryPrice) * b.currentQty;
        b.priceDev = ((markP - b.entryPrice) / b.entryPrice) * 100;
    } else {
        b.pnl = (b.entryPrice - markP) * b.currentQty;
        b.priceDev = ((b.entryPrice - markP) / b.entryPrice) * 100;
    }
    botActivePositions.set(key, b); 

    let isBreached = false;
    if (b.side === 'SHORT' && (markP <= b.tp || markP >= b.sl)) isBreached = true;
    if (b.side === 'LONG' && (markP >= b.tp || markP <= b.sl)) isBreached = true;

    if (isBreached) {
        b.isClosing = true; 
        botActivePositions.set(key, b);
        
        runLocked(b.symbol, async () => {
            const info = status.exchangeInfo[b.symbol];
            const sideClose = b.side === 'SHORT' ? 'BUY' : 'SELL';
            const cleanQty = Number(b.currentQty.toFixed(getPrecision(info.stepSize)));
            
            addBotLog(`🎯 [TRIG] ${b.symbol} chạm ngưỡng nội bộ (${markP}). Dập lệnh MARKET!`, 'warning');
            try {
                await binanceRequest('POST', '/fapi/v1/order', {
                    symbol: b.symbol, side: sideClose, positionSide: status.isHedgeMode ? b.side : 'BOTH',
                    type: 'MARKET', quantity: cleanQty
                });
            } catch (err) {
                b.isClosing = false;
                botActivePositions.set(key, b);
            }
        });
    }
}

async function executePositionClosureAccounting(symbol, positionSideParam, key, b) {
    botActivePositions.delete(key); 
    saveBotStateToDisk();

    await new Promise(r => setTimeout(r, 3000));

    let totalRealizedPnl = 0;
    let isConfirmedClosed = false;
    let retryCount = 0;

    // KHÓA LUỒNG XÁC THỰC LẤY PNL THỰC TẾ
    while (!isConfirmedClosed && retryCount < 10) {
        try {
            const trades = await binanceRequest('GET', '/fapi/v1/userTrades', { symbol, limit: 10 }).catch(() => []);
            const recentCloseTrades = trades.filter(t => 
                (Date.now() - t.time) < 120000 && 
                t.positionSide === positionSideParam && 
                parseFloat(t.realizedPnl) !== 0
            );

            if (recentCloseTrades.length > 0) {
                recentCloseTrades.forEach(t => totalRealizedPnl += parseFloat(t.realizedPnl));
                isConfirmedClosed = true; 
            } else {
                const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
                const targetRisk = freshRisk.find(x => x.positionSide === positionSideParam);
                if (!targetRisk || Math.abs(parseFloat(targetRisk.positionAmt)) === 0) {
                    isConfirmedClosed = true; 
                }
            }
        } catch (e) {}

        if (!isConfirmedClosed) {
            retryCount++;
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    if (!isConfirmedClosed) {
        addBotLog(`🚨 [TIMEOUT] Không lấy được PnL cho ${symbol}. Khóa bảo vệ tài khoản!`, 'error');
        status.blackList[symbol] = Math.floor((Date.now() + (5 * 60 * 1000)) / 1000); 
        return;
    }

    // Cộng dồn vào Stats hiển thị lên giao diện
    status.botClosedCount += 1;
    status.botPnLClosed += totalRealizedPnl;

    if (totalRealizedPnl > (-b.firstMargin * 0.05)) {
        status.blackList[symbol] = Math.floor((Date.now() + (15 * 60 * 1000)) / 1000); 
        addBotLog(`💰 [WIN] ${symbol} chốt lời: +${totalRealizedPnl.toFixed(2)}$`, 'success');
    } else {
        addBotLog(`❌ [SL CUT] ${symbol} dính SL lỗ thực tế: ${totalRealizedPnl.toFixed(2)}$`);
        
        const nextDcaLevel = b.dcaCount + 1;
        if (nextDcaLevel <= botSettings.maxDCA) {
            // CÔNG THỨC CẤP SỐ CỘNG VỐN NHỒI
            const nextMargin = b.firstMargin + nextDcaLevel; 
            addBotLog(`🔄 [DCA] Kích hoạt tầng [${nextDcaLevel}/${botSettings.maxDCA}] | Vốn nhồi: ${nextMargin}$ cho ${symbol}`);
            await openPosition(symbol, { ...b, dcaCount: nextDcaLevel, margin: nextMargin });
        } else {
            // ĐẢO VỊ THẾ KHI GÃY CHUỖI VẪN GIỮ NGUYÊN
            addBotLog(`🚨 [QUAY XE] Đảo vị thế, tổng lực vã LONG x20 vốn gốc vào ${symbol}!`);
            await openPosition(symbol, { ...b, side: 'LONG', isFinalLong: true, dcaCount: 0, margin: b.firstMargin * 20 });
        }
    }
    saveBotStateToDisk();
}

async function openPosition(symbol, dcaData = null) {
    if (!status.exchangeInfo[symbol] || !botSettings.isRunning) return;

    const isLong = dcaData ? (dcaData.isFinalLong || dcaData.side === 'LONG') : false; 
    const side = isLong ? 'LONG' : 'SHORT';
    
    try {
        const info = status.exchangeInfo[symbol];
        let margin = (dcaData && dcaData.margin) ? dcaData.margin : parseFloat(botSettings.invValue);
        
        const freshRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol });
        const symbolRisk = freshRisk.find(x => x.positionSide === (status.isHedgeMode ? side : 'BOTH')) || freshRisk[0];
        const price = parseFloat(symbolRisk.markPrice);
        if (!price || price === 0) return;
        
        let qty = Number(((margin * info.maxLeverage) / price).toFixed(getPrecision(info.stepSize)));
        if (isNaN(qty) || qty <= 0) return;

        if (!leverageCache.has(symbol)) {
            await binanceRequest('POST', '/fapi/v1/leverage', { symbol, leverage: info.maxLeverage }).catch(() => {});
            leverageCache.add(symbol);
        }
        
        const order = await binanceRequest('POST', '/fapi/v1/order', { 
            symbol, side: isLong ? 'BUY' : 'SELL', positionSide: status.isHedgeMode ? side : 'BOTH', 
            type: 'MARKET', quantity: qty
        });
        
        if (order?.orderId) {
            await new Promise(r => setTimeout(r, 500));
            const pRisk = await binanceRequest('GET', '/fapi/v2/positionRisk', { symbol }).catch(() => []);
            const p = pRisk.find(x => x.positionSide === (status.isHedgeMode ? side : 'BOTH'} && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                const entry = parseFloat(p.entryPrice);
                const firstE = (dcaData && dcaData.firstEntry) ? dcaData.firstEntry : entry;
                const dcaLevel = dcaData ? dcaData.dcaCount : 0;

                let tp, sl;
                if (isLong) {
                    tp = entry * (1 + botSettings.posTP / 100);
                    sl = firstE - (firstE * (((dcaLevel + 1) * botSettings.posSL) / 100));
                } else {
                    tp = entry * (1 - botSettings.posTP / 100);
                    sl = firstE + (firstE * (((dcaLevel + 1) * botSettings.posSL) / 100));
                }

                botActivePositions.set(`${symbol}_${status.isHedgeMode ? side : 'BOTH'}`, { 
                    symbol, side, entryPrice: entry, tp, sl, dcaCount: dcaLevel,
                    firstEntry: firstE, firstMargin: (dcaData && dcaData.firstMargin) ? dcaData.firstMargin : margin,
                    currentQty: Math.abs(parseFloat(p.positionAmt)), pnl: 0, priceDev: 0, isClosing: false,
                    leverage: info.maxLeverage // Trả thêm thuộc tính này để HTML hiển thị xLeverage gần tên Coin
                });
                saveBotStateToDisk();
                addBotLog(`🎬 [MỞ] vị thế ${symbol} [${side}] (Tầng DCA: ${dcaLevel}) | Vốn: ${margin}$`);
            }
        }
    } catch (e) { 
        status.blackList[symbol] = Math.floor((Date.now() + (5 * 60 * 1000)) / 1000); 
    }
}

async function runPositionReconciliationEngine() {
    try {
        const posRisk = await binanceRequest('GET', '/fapi/v2/positionRisk');
        const activeOnChainPositions = posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        for (const [key, localPos] of botActivePositions.entries()) {
            const existsOnChain = activeOnChainPositions.some(p => `${p.symbol}_${p.positionSide}` === key);
            if (!existsOnChain) {
                await executePositionClosureAccounting(localPos.symbol, key.split('_')[1], key, localPos);
            }
        }
    } catch (e) {}
}

const APP = express(); 
APP.use(express.json());
APP.use(express.static(path.join(__dirname))); // Đọc file index.html tại thư mục chạy bot

// =========================================================================
// 🌐 ENDPOINT 1: TRẢ DỮ LIỆU ĐÚNG ĐỊNH DẠNG CÂY OBJECT HTML YÊU CẦU
// =========================================================================
APP.get('/api/status', async (req, res) => {
    let walletData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
    try {
        const acc = await binanceRequest('GET', '/fapi/v2/account');
        const botUnrealizedPnL = Array.from(botActivePositions.values()).reduce((sum, p) => sum + (p.pnl || 0), 0);
        walletData = { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
            totalUnrealizedProfit: botUnrealizedPnL.toFixed(2) 
        };
    } catch (e) {}

    // Xử lý đếm lùi thời gian chặn blacklist trước khi đẩy về UI (Đổi mốc timestamp thành số giây đếm ngược)
    const nowSec = Math.floor(Date.now() / 1000);
    const renderBlacklist = {};
    for (const [sym, endSec] of Object.entries(status.blackList)) {
        const remain = endSec - nowSec;
        if (remain > 0) {
            renderBlacklist[sym] = remain;
        }
    }

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        wallet: walletData,
        status: {
            botLogs: status.botLogs,
            candidatesList: status.candidatesList,
            blackList: renderBlacklist,
            botClosedCount: status.botClosedCount,
            botPnLClosed: status.botPnLClosed
        }
    });
});

// =========================================================================
// 🌐 ENDPOINT 2: POST ĐỂ NHẬN LỆNH LƯU VÀ TOGGLE RUNNING TỪ HTML
// =========================================================================
APP.post('/api/settings', (req, res) => {
    if (req.body) {
        botSettings = { ...botSettings, ...req.body };
        saveBotStateToDisk();
        addBotLog(`⚙️ Cập nhật cấu hình hệ thống thành công.`);
    }
    res.json({ success: true });
});

async function init() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
            if (parsed.botActivePositions) botActivePositions = new Map(parsed.botActivePositions);
            if (parsed.blackList) status.blackList = parsed.blackList;
            if (parsed.botSettings) botSettings = { ...botSettings, ...parsed.botSettings };
            if (parsed.botClosedCount) status.botClosedCount = parsed.botClosedCount;
            if (parsed.botPnLClosed) status.botPnLClosed = parsed.botPnLClosed;
        }
    } catch (e) {}
    
    try {
        const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
        serverTimeOffset = t.data.serverTime - Date.now();
        const posMode = await binanceRequest('GET', '/fapi/v1/positionSide/dual');
        status.isHedgeMode = posMode.dualSidePosition;

        const info = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        const brk = await binanceRequest('GET', '/fapi/v2/leverageBracket').catch(() => []);
        
        const temp = {};
        info.data.symbols.forEach(s => {
            const b = brk.find(x => x.symbol === s.symbol);
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            temp[s.symbol] = { 
                stepSize: parseFloat(lot.stepSize), 
                minNotional: notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional) : 5.0, 
                maxLeverage: b?.brackets[0]?.initialLeverage || 20 
            };
        });
        status.exchangeInfo = temp; status.isReady = true; 
        await runPositionReconciliationEngine();
        await initWebSocketEngine();
        addBotLog(`🚀 [SYSTEM READY] AUTO SHORT - Cấp số cộng Margin.`);
    } catch (e) { setTimeout(init, 4000); }
}
init();

setInterval(() => { if (status.isReady) runPositionReconciliationEngine(); }, 20000);
setInterval(() => {
    if (!status.isReady || !botSettings.isRunning || botActivePositions.size >= botSettings.maxPositions || openingSymbols.size > 0) return;
    const can = status.candidatesList.find(c => {
        const info = status.exchangeInfo[c.symbol];
        if (!info || status.blackList[c.symbol] || Math.abs(c.c1) < botSettings.minVol) return false;
        return !botActivePositions.has(`${c.symbol}_SHORT`);
    });
    if (can) {
        runLocked(can.symbol, async () => {
            if (botActivePositions.has(`${can.symbol}_SHORT`) || openingSymbols.has(can.symbol) || botActivePositions.size >= botSettings.maxPositions) return;
            openingSymbols.add(can.symbol);
            try { await openPosition(can.symbol); } finally { openingSymbols.delete(can.symbol); }
        });
    }
}, 300);

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 400);

APP.listen(9001);
