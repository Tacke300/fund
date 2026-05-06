import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cấu hình cố định
const RECV_WINDOW = 5000; // Sửa lỗi -1131: phải < 60000
const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 15000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { 
        defaultType: 'future', 
        dualSidePosition: true, 
        adjustForTimeDifference: true, 
        recvWindow: RECV_WINDOW 
    } 
});

let botSettings = { isRunning: false, maxPositions: 3, invValue: "1%", minVol: 6.5, posTP: 0.5, posSL: 50.0, dcaStep: 10.0, maxDCA: 4 };
let status = { botLogs: [], exchangeInfo: {}, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0, botPnLClosed: 0, publicIP: "Đang kiểm tra..." };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set(); 
let lastLogMsg = ""; // Chặn spam log trùng lặp

function addBotLog(msg, type = 'info') {
    if (msg === lastLogMsg) return; // Chặn spam nếu log giống hệt log trước đó
    lastLogMsg = msg;

    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

// Lấy chính xác IPv4 (Bỏ qua IPv6)
async function checkIP() {
    try {
        // Sử dụng api64.ipify.org để ép lấy IPv4 nếu có thể
        const res = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
        status.publicIP = res.data.ip;
        addBotLog(`🌐 IPv4 VPS: ${status.publicIP}`, "success");
    } catch (e) {
        try {
            const res2 = await axios.get('https://checkip.amazonaws.com', { timeout: 5000 });
            status.publicIP = res2.data.trim();
            addBotLog(`🌐 IPv4 VPS (Backup): ${status.publicIP}`, "success");
        } catch (e2) {
            status.publicIP = "Không thể lấy IPv4";
            addBotLog(`⚠️ Lỗi lấy IP: ${e2.message}`, "warning");
        }
    }
}

async function syncTime() { 
    try { 
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); 
        timestampOffset = res.data.serverTime - Date.now(); 
        addBotLog(`🕒 Sync Time OK (Offset: ${timestampOffset}ms)`);
    } catch (e) { addBotLog(`❌ Lỗi Sync Time: ${e.message}`, "error"); } 
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: RECV_WINDOW }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        const errorData = error.response?.data;
        if (errorData?.code === -1021) await syncTime();
        throw new Error(errorData ? `[${errorData.code}] ${errorData.msg}` : error.message);
    }
}

async function hardClearOrders(symbol, side) {
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 2000));
        return true;
    } catch (e) { return true; }
}

async function syncTPSL(symbol, side, entry, info) {
    const isShort = (side === 'SHORT');
    const tpPrice = (entry * (isShort ? (1 - botSettings.posTP / 100) : (1 + botSettings.posTP / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + botSettings.posSL / 100) : (1 - botSettings.posSL / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        await hardClearOrders(symbol, side);
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: 'true' });
        await new Promise(r => setTimeout(r, 500));
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: slPrice, closePosition: 'true' });
        addBotLog(`✨ [${symbol}] Đã cập nhật TP/SL`, "success");
        return { tp: Number(tpPrice), sl: Number(slPrice) };
    } catch (e) { 
        addBotLog(`❌ Lỗi sync TPSL ${symbol}: ${e.message}`, "error");
        throw e; 
    }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        if (!info) return;

        const currentPrice = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`).then(res => parseFloat(res.data.price));
        let marginToUse = 0, currentDCA = 0, firstMargin = 0;
        let currentPos = botActivePositions.get(posKey);

        if (isDCA && currentPos) {
            currentPos.isProcessing = true; 
            firstMargin = currentPos.firstMargin;
            marginToUse = firstMargin * 1.03; 
            currentDCA = currentPos.dcaCount + 1;
        } else {
            const acc = await binancePrivate('/fapi/v2/account');
            marginToUse = botSettings.invValue.toString().includes('%') 
                ? (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue.replace('%','')) / 100) 
                : parseFloat(botSettings.invValue);
            firstMargin = marginToUse;
        }

        let qtyNum = Math.ceil(((marginToUse * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 6) qtyNum = (6 / currentPrice); // Đảm bảo tối thiểu 6 USDT

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`💰 [${symbol}] ${isDCA ? 'DCA' : 'Mở lệnh'} thành công`, "success");
            await new Promise(r => setTimeout(r, 3000));
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            if (upPos && Math.abs(parseFloat(upPos.positionAmt)) > 0) {
                const finalEntry = parseFloat(upPos.entryPrice);
                const finalQty = Math.abs(parseFloat(upPos.positionAmt));
                const sync = await syncTPSL(symbol, 'SHORT', finalEntry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: finalEntry, qty: finalQty, tp: sync.tp, sl: sync.sl, 
                    margin: (finalQty * finalEntry / info.maxLeverage), firstMargin, dcaCount: currentDCA, 
                    leverage: info.maxLeverage, isProcessing: false, pnl: 0, markPrice: currentPrice
                });
            }
        }
    } catch (e) {
        addBotLog(`❌ Lỗi Open/DCA ${symbol}: ${e.message}`, "error");
        if (isDCA && botActivePositions.has(posKey)) botActivePositions.get(posKey).isProcessing = false;
    } finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const now = Date.now();
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = now + (10 * 60 * 1000); // 10p blacklist
                status.botClosedCount++;
                botActivePositions.delete(key);
                addBotLog(`✅ Đã chốt vị thế ${botPos.symbol}`, "success");
            } else {
                botPos.markPrice = parseFloat(realPos.markPrice); 
                botPos.pnl = parseFloat(realPos.unRealizedProfit);
            }
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 2000);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    try {
        // Kiểm tra DCA
        for (let [key, botPos] of botActivePositions) {
            if (botPos.isProcessing) continue; 
            const priceDev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
            if (priceDev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) { 
                await openPosition(botPos.symbol, true); 
            }
        }
        // Kiểm tra mở lệnh mới
        if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
            const keo = status.candidatesList.find(c => {
                const info = status.exchangeInfo[c.symbol];
                const hasVol = [c.c1, c.c5].some(v => Math.abs(parseFloat(v)) >= parseFloat(botSettings.minVol));
                return info && (status.blackList[c.symbol] || 0) < Date.now() && !botActivePositions.has(`${c.symbol}_SHORT`) && hasVol;
            });
            if (keo) await openPosition(keo.symbol, false);
        }
    } catch (e) {}
}

async function init() {
    addBotLog("🚀 Hệ thống đang khởi động...");
    await checkIP();
    await syncTime();
    try {
        await exchange.loadMarkets();
        const [infoRes, brkRes] = await Promise.all([
            binanceApi.get('/fapi/v1/exchangeInfo'),
            binancePrivate('/fapi/v1/leverageBracket')
        ]);
        
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = (Array.isArray(brkRes) ? brkRes : brkRes.brackets || []).find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo; 
        status.isReady = true;
        addBotLog("👿 LUFFY BOT ONLINE", "success");
        priceMonitorLoop();
    } catch (e) { 
        addBotLog("⚠️ Lỗi khởi động: " + e.message, "error");
        setTimeout(init, 10000); 
    }
}

init(); 
setInterval(mainLoop, 4000);
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 3000);

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));
APP.get('/api/status', async (req, res) => {
    try {
        let accData = { totalWalletBalance: "0.00", availableBalance: "0.00", totalUnrealizedProfit: "0.00" };
        try {
            const acc = await binancePrivate('/fapi/v2/account');
            accData = { 
                totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
                availableBalance: parseFloat(acc.availableBalance).toFixed(2), 
                totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit).toFixed(2) 
            };
        } catch (e) {}
        const bl = {}; 
        Object.entries(status.blackList).forEach(([s, t]) => { 
            const left = Math.ceil((t - Date.now()) / 1000);
            if(left > 0) bl[s] = left; 
        });
        res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status: { ...status, blackList: bl }, wallet: accData });
    } catch (e) { res.json({ botSettings, activePositions: [], status, wallet: {} }); }
});
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
APP.listen(9001);
