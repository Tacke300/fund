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
const RECV_WINDOW = 50000;

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

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1%", 
    minVol: 6.5, 
    posTP: 0.5, 
    posSL: 50.0, 
    dcaStep: 10.0, 
    maxDCA: 4 
};

let status = { 
    botLogs: [], 
    exchangeInfo: {}, 
    candidatesList: [], 
    isReady: false, 
    blackList: {}, 
    botClosedCount: 0, 
    publicIP: "Đang kiểm tra..." 
};

let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();
let lastLogMsg = "";

function addBotLog(msg, type = 'info') {
    if (msg === lastLogMsg) return;
    lastLogMsg = msg;
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function syncTime() { 
    try { 
        const res = await axios.get('https://fapi.binance.com/fapi/v1/time'); 
        timestampOffset = res.data.serverTime - Date.now(); 
    } catch (e) {} 
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: RECV_WINDOW }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ 
            method, 
            url: `${endpoint}?${query}&signature=${signature}` 
        });
        return response.data;
    } catch (error) {
        if (error.response?.data?.code === -1021) await syncTime();
        throw new Error(error.response?.data?.msg || error.message);
    }
}

// FIX LỖI -4130: Xóa sạch lệnh chờ trước khi ghi đè lệnh mới
async function hardClearOrders(symbol) {
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {}
}

// HYBRID TP/SL LOGIC
async function syncTPSL(symbol, side, entry, info, isHedge = false) {
    const isShort = (side === 'SHORT');
    const tpPrice = Number((entry * (isShort ? (1 - (isHedge ? 10 : botSettings.posTP) / 100) : (1 + 10 / 100))).toFixed(info.pricePrecision));
    const slPrice = Number((entry * (isShort ? (1 + (isHedge ? 10 : botSettings.posSL) / 100) : (1 - 10 / 100))).toFixed(info.pricePrecision));
    const sideClose = isShort ? 'buy' : 'sell';

    try {
        await hardClearOrders(symbol);
        // Đặt TP Limit và SL Market
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: tpPrice, closePosition: 'true' });
        await new Promise(r => setTimeout(r, 1000));
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, 1, undefined, { positionSide: side, stopPrice: slPrice, closePosition: 'true' });
        
        addBotLog(`✨ [${symbol}] TP/SL: ${tpPrice} / ${slPrice}`, "success");
        return { tp: tpPrice, sl: slPrice };
    } catch (e) {
        addBotLog(`❌ Lỗi TPSL ${symbol}: ${e.message}`, "error");
        return { tp: tpPrice, sl: slPrice };
    }
}

// HEDGE LONG x50 KHI KỊCH DCA
async function openHedgeLong(symbol, firstMargin, info) {
    try {
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        // Đánh x50 dựa trên vốn đầu
        const qty = Math.ceil((firstMargin * 50 * info.maxLeverage / currentPrice) / info.stepSize) * info.stepSize;
        
        await exchange.setLeverage(info.maxLeverage, symbol);
        await exchange.createOrder(symbol, 'market', 'buy', qty.toFixed(info.quantityPrecision), undefined, { positionSide: 'LONG' });
        
        addBotLog(`🛡️ [${symbol}] MỞ HEDGE LONG x50`, "warning");
        await syncTPSL(symbol, 'LONG', currentPrice, info, true);
    } catch (e) { addBotLog(`🚨 Hedge Lỗi: ${e.message}`, "error"); }
}

async function openPosition(symbol, isDCA = false) {
    const posKey = `${symbol}_SHORT`;
    if (!isDCA && (botActivePositions.size >= botSettings.maxPositions || botActivePositions.has(posKey) || openingSymbols.has(symbol))) return;
    openingSymbols.add(symbol); 

    try {
        const info = status.exchangeInfo[symbol];
        const priceRes = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(priceRes.data.price);
        let currentPos = botActivePositions.get(posKey);
        
        const acc = await binancePrivate('/fapi/v2/account');
        // FIX: DCA x1.03 theo margin đầu
        let margin = isDCA ? (currentPos.firstMargin * 1.03) : (botSettings.invValue.toString().includes('%') ? 
            (parseFloat(acc.availableBalance) * parseFloat(botSettings.invValue) / 100) : parseFloat(botSettings.invValue));

        let qtyNum = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        if ((qtyNum * currentPrice) < 6.5) qtyNum = (6.5 / currentPrice);

        await exchange.setLeverage(info.maxLeverage, symbol);
        const order = await exchange.createOrder(symbol, 'market', 'sell', qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: 'SHORT' });

        if (order) {
            addBotLog(`💰 [${symbol}] ${isDCA ? `DCA #${currentPos.dcaCount + 1}` : 'Mở SHORT'}`);
            await new Promise(r => setTimeout(r, 4000)); // Đợi sàn cập nhật vị thế
            
            const posRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const upPos = posRisk.find(p => p.positionSide === 'SHORT');
            
            if (upPos && Math.abs(parseFloat(upPos.positionAmt)) > 0) {
                const entry = parseFloat(upPos.entryPrice);
                const sync = await syncTPSL(symbol, 'SHORT', entry, info);
                botActivePositions.set(posKey, { 
                    symbol, side: 'SHORT', entryPrice: entry, qty: Math.abs(parseFloat(upPos.positionAmt)), 
                    tp: sync.tp, sl: sync.sl, firstMargin: isDCA ? currentPos.firstMargin : margin, 
                    dcaCount: isDCA ? currentPos.dcaCount + 1 : 0, isProcessing: false, hedgeOpened: isDCA ? currentPos.hedgeOpened : false
                });
            }
        }
    } catch (e) { addBotLog(`❌ Lỗi: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

async function priceMonitorLoop() {
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        for (let [key, botPos] of botActivePositions) {
            const realPos = posRisk.find(p => p.symbol === botPos.symbol && p.positionSide === botPos.side);
            if (!realPos || Math.abs(parseFloat(realPos.positionAmt)) === 0) {
                status.blackList[botPos.symbol] = Date.now() + 600000;
                botActivePositions.delete(key);
                addBotLog(`✅ [${botPos.symbol}] Đóng vị thế.`, "success");
                continue;
            }
            botPos.markPrice = parseFloat(realPos.markPrice);
            botPos.pnl = parseFloat(realPos.unRealizedProfit);
        }
    } catch (e) {}
    setTimeout(priceMonitorLoop, 1500);
}

async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    for (let [key, botPos] of botActivePositions) {
        if (botPos.isProcessing) continue;
        const dev = ((botPos.markPrice - botPos.entryPrice) / botPos.entryPrice) * 100;
        
        // DCA Logic
        if (dev >= botSettings.dcaStep && botPos.dcaCount < botSettings.maxDCA) {
            await openPosition(botPos.symbol, true);
        } 
        // Hedge Logic
        else if (dev >= (botSettings.dcaStep * 1.5) && botPos.dcaCount >= botSettings.maxDCA && !botPos.hedgeOpened) {
            botPos.hedgeOpened = true;
            await openHedgeLong(botPos.symbol, botPos.firstMargin, status.exchangeInfo[botPos.symbol]);
        }
    }
    
    // Mở vị thế mới
    if (botActivePositions.size < botSettings.maxPositions && openingSymbols.size === 0) {
        const keo = status.candidatesList.find(c => {
            const info = status.exchangeInfo[c.symbol];
            return info && (status.blackList[c.symbol] || 0) < Date.now() && !botActivePositions.has(`${c.symbol}_SHORT`) && [c.c1, c.c5].some(v => Math.abs(v) >= botSettings.minVol);
        });
        if (keo) await openPosition(keo.symbol, false);
    }
}

async function init() {
    await syncTime();
    try {
        await exchange.loadMarkets();
        const [infoRes, brkRes] = await Promise.all([
            binanceApi.get('/fapi/v1/exchangeInfo'), 
            binancePrivate('/fapi/v1/leverageBracket')
        ]);
        infoRes.data.symbols.forEach(s => {
            const brk = brkRes.find(b => b.symbol === s.symbol);
            status.exchangeInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.isReady = true; 
        addBotLog("👿 LUFFY BOT - BẢN FULL KHÔNG RÚT GỌN ONLINE", "success");
        priceMonitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

const APP = express(); 
APP.use(express.json()); 
APP.use(express.static(__dirname));

APP.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

APP.get('/api/status', async (req, res) => {
    let wallet = { totalWalletBalance: "0.00", availableBalance: "0.00" };
    try {
        const acc = await binancePrivate('/fapi/v2/account');
        // Trả về Balance bao gồm Equity (dùng totalWalletBalance)
        wallet = { 
            totalWalletBalance: parseFloat(acc.totalWalletBalance).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance).toFixed(2) 
        };
    } catch (e) {}
    res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status, wallet });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    addBotLog(`⚙️ Hệ thống: ${botSettings.isRunning ? "BẮT ĐẦU" : "TẠM DỪNG"}`, botSettings.isRunning ? "success" : "warning");
    res.json({ success: true }); 
});

APP.listen(9001);
init(); 
setInterval(mainLoop, 4000);

// Proxy lấy data từ bot quét (cổng 9000)
setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch (e) {} });
    }).on('error', () => {});
}, 3000);
