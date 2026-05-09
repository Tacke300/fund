import express from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CẤU HÌNH ---
const binanceApi = axios.create({ 
    baseURL: 'https://fapi.binance.com', 
    timeout: 20000, 
    headers: { 'X-MBX-APIKEY': API_KEY } 
});

const exchange = new ccxt.binance({ 
    apiKey: API_KEY, 
    secret: SECRET_KEY, 
    enableRateLimit: true,
    options: { defaultType: 'future', dualSidePosition: true, adjustForTimeDifference: true, recvWindow: 60000 } 
});

let botSettings = { 
    isRunning: false, 
    maxPositions: 3, 
    invValue: "1$",    // Margin khởi điểm
    minVol: 6.5,       // % Vol để lọc coin
    posTP: 0.5,        // TP vị thế Short (%)
    dcaStep: 1.0,      // SL vị thế Short (%), đồng thời là điểm DCA tiếp theo
    maxDCA: 5          // Tổng số lần Short tối đa trước khi Reverse
};

let status = { botLogs: [], exchangeInfo: null, candidatesList: [], isReady: false, blackList: {}, botClosedCount: 0 };
let botActivePositions = new Map();
let timestampOffset = 0; 
let openingSymbols = new Set();

// --- TIỆN ÍCH ---
function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now() + timestampOffset;
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) { throw new Error(e.response?.data?.msg || e.message); }
}

async function clearOrders(symbol) {
    try {
        await binancePrivate('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
    } catch (e) {}
}

async function syncTPSL(symbol, side, entry, info, qty, tpPercent, slPercent) {
    const isShort = side === 'SHORT';
    const tpPrice = (entry * (isShort ? (1 - tpPercent / 100) : (1 + tpPercent / 100))).toFixed(info.pricePrecision);
    const slPrice = (entry * (isShort ? (1 + slPercent / 100) : (1 - slPercent / 100))).toFixed(info.pricePrecision);
    const sideClose = isShort ? 'BUY' : 'SELL';
    const finalQty = Math.abs(qty).toFixed(info.quantityPrecision);

    try {
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, finalQty, undefined, {
            positionSide: side, stopPrice: tpPrice, reduceOnly: true, workingType: 'MARK_PRICE'
        });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, finalQty, undefined, {
            positionSide: side, stopPrice: slPrice, reduceOnly: true, workingType: 'MARK_PRICE'
        });
        return { tp: parseFloat(tpPrice), sl: parseFloat(slPrice) };
    } catch (e) {
        addBotLog(`❌ [${symbol}] Lỗi TPSL: ${e.message}`, "error");
        return { tp: 0, sl: 0 };
    }
}

// --- LOGIC MỞ VỊ THẾ ---
async function openPosition(symbol, dcaIteration = 0, isReverse = false, baseMargin = 0) {
    if (openingSymbols.has(symbol)) return;
    openingSymbols.add(symbol);

    try {
        const info = status.exchangeInfo[symbol];
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let marginToUse = 0;
        let side = 'SHORT';

        if (isReverse) {
            marginToUse = baseMargin * 50; // REVERSE x50
            side = 'LONG';
            addBotLog(`🚀 [${symbol}] REVERSE LONG! Margin: ${marginToUse}$`, "warning");
        } else {
            // Hệ số tự động: Lần 1 = 1, Lần 2 = 2.2, Lần 3 = 3.3...
            const factor = dcaIteration === 0 ? 1 : (dcaIteration + 1) * 1.1;
            marginToUse = baseMargin * factor;
            addBotLog(`🔄 [${symbol}] SHORT Lần ${dcaIteration + 1}, Margin: ${marginToUse.toFixed(2)}$`);
        }

        let qtyNum = (marginToUse * info.maxLeverage) / currentPrice;
        qtyNum = Math.ceil(qtyNum / info.stepSize) * info.stepSize;

        await exchange.setLeverage(info.maxLeverage, symbol);
        const orderSide = (side === 'SHORT') ? 'SELL' : 'BUY';
        
        await exchange.createOrder(symbol, 'MARKET', orderSide, qtyNum.toFixed(info.quantityPrecision), undefined, { positionSide: side });

        await new Promise(r => setTimeout(r, 1500));
        const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
        const realP = pRisk.find(p => p.positionSide === side && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (realP) {
            const finalEntry = parseFloat(realP.entryPrice);
            const currentQty = Math.abs(parseFloat(realP.positionAmt));
            
            // Nếu Reverse thì TP/SL 10%. Nếu Short thì SL = dcaStep
            const tpVal = isReverse ? 10.0 : botSettings.posTP;
            const slVal = isReverse ? 10.0 : botSettings.dcaStep;

            const sync = await syncTPSL(symbol, side, finalEntry, info, currentQty, tpVal, slVal);
            
            botActivePositions.set(`${symbol}_${side}`, {
                symbol, side, entryPrice: finalEntry, qty: currentQty,
                tp: sync.tp, sl: sync.sl, margin: marginToUse,
                firstMargin: baseMargin, dcaCount: dcaIteration, isReverse
            });
        }
    } catch (e) { addBotLog(`🚨 [${symbol}] Lỗi mở: ${e.message}`, "error"); }
    finally { openingSymbols.delete(symbol); }
}

// --- GIÁM SÁT VỊ THẾ ---
async function monitorLoop() {
    if (!status.isReady) return setTimeout(monitorLoop, 1000);
    try {
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        const activeKeys = new Set(posRisk.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).map(p => `${p.symbol}_${p.positionSide}`));

        for (let [key, botPos] of botActivePositions) {
            if (!activeKeys.has(key)) {
                addBotLog(`📉 [${botPos.symbol}] ${botPos.side} đã đóng (TP/SL).`);
                await clearOrders(botPos.symbol);
                botActivePositions.delete(key);

                // Kiểm tra xem vị thế đóng do dính SL (giá tăng đối với Short) hay không
                const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${botPos.symbol}`);
                const currentPrice = parseFloat(ticker.data.price);
                const isHitSL = botPos.side === 'SHORT' && currentPrice > botPos.entryPrice;

                if (isHitSL && !botPos.isReverse) {
                    if (botPos.dcaCount + 1 < botSettings.maxDCA) {
                        // Tiếp tục vòng DCA Short tăng margin
                        await openPosition(botPos.symbol, botPos.dcaCount + 1, false, botPos.firstMargin);
                    } else {
                        // Kích hoạt Reverse Long lần cuối
                        await openPosition(botPos.symbol, 0, true, botPos.firstMargin);
                    }
                } else {
                    // Nếu là chốt lời (TP) hoặc kết thúc lệnh Reverse, cho vào blacklist 15p
                    status.blackList[botPos.symbol] = Date.now() + 900000;
                    status.botClosedCount++;
                }
            }
        }
    } catch (e) {}
    setTimeout(monitorLoop, 1000);
}

// --- VÒNG LẶP TÌM LỆNH MỚI ---
async function mainLoop() {
    if (!status.isReady || !botSettings.isRunning) return;
    
    if (botActivePositions.size < botSettings.maxPositions) {
        const candidate = status.candidatesList.find(c => {
            const volOK = Math.abs(parseFloat(c.c1)) >= botSettings.minVol;
            const notInUse = !botActivePositions.has(`${c.symbol}_SHORT`) && !botActivePositions.has(`${c.symbol}_LONG`);
            const notBlacklisted = !status.blackList[c.symbol] || status.blackList[c.symbol] < Date.now();
            return volOK && notInUse && notBlacklisted && !openingSymbols.has(c.symbol);
        });

        if (candidate) {
            const baseMargin = parseFloat(botSettings.invValue.replace('$', ''));
            await openPosition(candidate.symbol, 0, false, baseMargin);
        }
    }
}

// --- KHỞI TẠO ---
async function init() {
    try {
        const timeRes = await axios.get('https://fapi.binance.com/fapi/v1/time');
        timestampOffset = timeRes.data.serverTime - Date.now();
        await exchange.loadMarkets();
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brkRes.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: brk ? brk.brackets[0].initialLeverage : 20 
            };
        });
        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👹 LUFFY V6 - DCA SL & REVERSE ONLINE", "success");
        monitorLoop();
    } catch (e) { setTimeout(init, 5000); }
}

init();
setInterval(mainLoop, 3000);

// Fetch candidate list từ server dữ liệu
setInterval(() => {
    axios.get('http://127.0.0.1:9000/api/data').then(res => {
        status.candidatesList = res.data.live || [];
    }).catch(() => {});
}, 2000);

// --- API SERVER ---
const APP = express(); APP.use(express.json());
APP.get('/api/status', (req, res) => res.json({ botSettings, activePositions: Array.from(botActivePositions.values()), status }));
APP.post('/api/settings', (req, res) => { botSettings = { ...botSettings, ...req.body }; res.json({ success: true }); });
APP.listen(9001);
