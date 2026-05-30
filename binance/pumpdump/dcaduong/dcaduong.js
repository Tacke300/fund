import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';
import { checkEntryCondition } from './dieukien.js';

const MAX_DCA_LEVEL = 99999;            
const MARGIN_PROTECT_LIMIT = 60;    
const MARGIN_RECOVER_LIMIT = 70;    

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({ baseURL: 'https://fapi.binance.com', timeout: 15000, headers: { 'X-MBX-APIKEY': API_KEY } });
const exchange = new ccxt.binance({ 
    apiKey: API_KEY, secret: SECRET_KEY, enableRateLimit: true, 
    options: { defaultType: 'future', dualSidePosition: true, recvWindow: 60000, adjustForTimeDifference: true } 
});

let botSettings = { 
    isRunning: false, maxPositions: 3, invValue: "1%", minVol: 7, posTP: 10, posSL: 10.0, 
    dianguctp: 30, diangucsl: 10, diangucdca: 10, posdca: 3, diangucvol: 15, maxDCA: MAX_DCA_LEVEL 
};
let status = { botLogs: [], candidatesList: [], blackList: {}, permanentBlacklist: {}, botClosedCount: 0, botPnLClosed: 0, exchangeInfo: null, isReady: false };
let botActivePositions = new Map(); 
let isProcessingDCA = new Set();
let logThrottle = new Map(); 
let timestampOffset = 0;
let isMarginProtected = false; 

function addBotLog(msg, type = 'info', throttleKey = null) {
    if (throttleKey) {
        const now = Date.now();
        const last = logThrottle.get(throttleKey) || 0;
        if (now - last < 10000) return; 
        logThrottle.set(throttleKey, now);
    }
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 200) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    try {
        const timestamp = Date.now() + timestampOffset;
        const query = new URLSearchParams({ ...data, timestamp, recvWindow: 60000 }).toString(); 
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (e) {
        if (e.response?.data?.code === -1021) {
            const t = await axios.get('https://fapi.binance.com/fapi/v1/time');
            timestampOffset = t.data.serverTime - Date.now();
            return binancePrivate(endpoint, method, data);
        }
        throw e;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const symbol in status.blackList) {
        if (now > status.blackList[symbol]) delete status.blackList[symbol];
    }
}, 1000);

async function initBot() {
    const symbols = Object.keys(status.exchangeInfo);
    for (const symbol of symbols) {
        await setCrossMargin(symbol).catch(()=>{});
        await new Promise(r => setTimeout(r, 100)); 
    }
    status.isReady = true;
    priceMonitor(); 
    addBotLog(`🚀 Hoàn tất setup CROSS margin. Bot đã sẵn sàng.`, "success");
}

async function setCrossMargin(symbol) {
    try {
        await binancePrivate('/fapi/v1/marginType', 'POST', { symbol: symbol, marginType: 'CROSSED', timestamp: Date.now() });
    } catch (error) {}
}

async function closePositionAndLog(b, markP, reasonStr) {
    try {
        await exchange.createOrder(b.symbol, 'MARKET', b.side === 'SHORT' ? 'BUY' : 'SELL', b.currentQty, undefined, { positionSide: b.side });
        
        let pnlRaw = 0;
        if (b.side === 'LONG') pnlRaw = (markP - b.avgEntry) * b.currentQty;
        else pnlRaw = (b.avgEntry - markP) * b.currentQty;
        
        const fee = (b.currentQty * markP * 0.001); 
        const finalPnL = pnlRaw - fee;

        status.botClosedCount++;
        status.botPnLClosed += finalPnL;
        status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000); 

        addBotLog(`🔒 [${reasonStr}] ${b.symbol} | Giá: ${markP.toFixed(4)} | PnL: ${finalPnL.toFixed(2)}$ (-0.1% phí)`, finalPnL >= 0 ? "success" : "warn");
        
        const openOrders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol: b.symbol });
        for (const o of openOrders.filter(o => o.positionSide === b.side)) {
            await binancePrivate('/fapi/v1/order', 'DELETE', { symbol: b.symbol, orderId: o.orderId }).catch(()=>{});
        }
    } catch (e) {
        addBotLog(`❌ Lỗi đóng ${b.symbol}: ${e.message}`, "error");
    }
}

async function priceMonitor() {
    if (!status.isReady) return setTimeout(priceMonitor, 1000);
    try {
        if (!botSettings.isRunning) return setTimeout(priceMonitor, 1000);
        const posRisk = await binancePrivate('/fapi/v2/positionRisk');
        
        for (let [key, b] of botActivePositions) {
            const realP = posRisk.find(p => `${p.symbol}_${p.positionSide}` === key && Math.abs(parseFloat(p.positionAmt)) > 0);
            const lockKey = `${b.symbol}_${b.side}`;

            if (realP) {
                const currentQty = Math.abs(parseFloat(realP.positionAmt));
                const markP = parseFloat(realP.markPrice);
                
                // Lấy Average Entry cực chuẩn từ Binance (Đã tính Qty)
                const avgEntry = parseFloat(realP.entryPrice); 
                
                b.currentQty = currentQty;
                b.livePrice = markP;
                b.pnl = parseFloat(realP.unRealizedProfit);
                b.avgEntry = avgEntry;

                let profitPercent = 0;
                if (b.side === 'LONG') profitPercent = ((markP - avgEntry) / avgEntry) * 100;
                else profitPercent = ((avgEntry - markP) / avgEntry) * 100;
                b.profitPercent = profitPercent;

                // ... phía trên trong hàm priceMonitor
                
                // --- SỬA LOGIC DCA TÍNH THEO FIRST ENTRY ---
                const dcaThreshold = b.isDiangucMode ? botSettings.diangucdca : botSettings.posdca;
                
                // DCA tính theo giá khởi đầu (First Entry)
                if (b.side === 'LONG') b.nextDCA = b.firstEntry * (1 + ((b.dcaCount + 1) * (dcaThreshold / 100)));
                else b.nextDCA = b.firstEntry * (1 - ((b.dcaCount + 1) * (dcaThreshold / 100)));

                // --- SỬA LOGIC KHIÊN CHẶN LÃI (TRAILING AVG) ---
                let shouldCloseMarket = false;
                if (b.dcaCount > 0) {
                    const x = b.dcaCount; // x là số lần đã DCA, dùng làm hệ số chặn lãi
                    // Chặn lãi vẫn phải dùng Avg để bảo vệ vốn tổng
                    if (b.side === 'LONG' && markP < (avgEntry * (1 + x / 100))) shouldCloseMarket = true;
                    if (b.side === 'SHORT' && markP > (avgEntry * (1 - x / 100))) shouldCloseMarket = true;
                }
// ... phía dưới giữ nguyên

                if (shouldCloseMarket) {
                    botActivePositions.delete(key);
                    await closePositionAndLog(b, markP, "CHỐT TRAILING AVG");
                    continue;
                }

                const hitTP = (b.side === 'SHORT' && markP <= b.tp) || (b.side === 'LONG' && markP >= b.tp);
                const hitSL = (b.side === 'SHORT' && markP >= b.sl) || (b.side === 'LONG' && markP <= b.sl);
                if (hitTP || hitSL) {
                    if (!b.hitTime) b.hitTime = Date.now();
                    if (Date.now() - b.hitTime > 30000) {
                        botActivePositions.delete(key);
                        await closePositionAndLog(b, markP, "ÉP ĐÓNG Treo > 30s");
                        continue;
                    }
                } else { b.hitTime = null; }

                const jump = b.dcaCount + 1;
                if (profitPercent >= dcaThreshold && jump <= botSettings.maxDCA) {
                    let marginToUse = b.isDiangucMode ? b.firstMargin * (jump * 2) : b.firstMargin;
                    
                    const logMsg = `[DCA LẦN ${jump}] ${b.symbol} | M: ${marginToUse.toFixed(2)}$ | E gốc: ${b.firstEntry.toFixed(4)} | Avg: ${avgEntry.toFixed(4)} | DCA Next: ${b.nextDCA.toFixed(4)}`;
                    addBotLog(logMsg, "info", `dca_${b.symbol}_${jump}`);

                    openPosition(b.symbol, { ...b, dcaCount: jump, margin: marginToUse }, b.side);
                }

            } else {
                if (isProcessingDCA.has(lockKey)) continue;
                botActivePositions.delete(key);
                status.blackList[b.symbol] = Date.now() + (15 * 60 * 1000);
            }
        }
    } catch (e) { }
    setTimeout(priceMonitor, 1000);
}

async function openPosition(symbol, dcaData = null, forcedSide = null) {
    const side = forcedSide || (dcaData ? dcaData.side : 'SHORT'); 
    const isDCAorLong = dcaData !== null;
    const lockKey = `${symbol}_${side}`;
    
    if (isProcessingDCA.has(lockKey)) return;
    isProcessingDCA.add(lockKey); 
    
    try {
        const info = status.exchangeInfo[symbol];
        if(!info) throw new Error("Coin không hỗ trợ");

        const acc = await binancePrivate('/fapi/v2/account');
        const availableUsdt = parseFloat(acc.availableBalance || 0);
        const ticker = await binanceApi.get(`/fapi/v1/ticker/price?symbol=${symbol}`);
        const currentPrice = parseFloat(ticker.data.price);
        
        let qty = 0, margin = 0;

        if (isDCAorLong) {
            margin = dcaData.margin;
            if ((margin * info.maxLeverage) < 6.5) margin = 6.5 / info.maxLeverage;
            qty = Math.ceil(((margin * info.maxLeverage) / currentPrice) / info.stepSize) * info.stepSize;
        } else {
            margin = botSettings.invValue.toString().includes('%') 
                ? (availableUsdt * parseFloat(botSettings.invValue) / 100) 
                : parseFloat(botSettings.invValue);

            const desiredQty = (margin * info.maxLeverage) / currentPrice;
            qty = Math.ceil(Math.max(desiredQty, 5.05 / currentPrice) / info.stepSize) * info.stepSize;
        }

        const actualMarginUsed = (qty * currentPrice) / info.maxLeverage;
        await exchange.setLeverage(info.maxLeverage, symbol);

        const order = await exchange.createOrder(symbol, 'MARKET', side === 'SHORT' ? 'SELL' : 'BUY', qty.toFixed(info.quantityPrecision), undefined, { positionSide: side });
        
        if (order) {
            await new Promise(r => setTimeout(r, 1500));
            const pRisk = await binancePrivate('/fapi/v2/positionRisk', 'GET', { symbol });
            const p = pRisk.find(x => x.positionSide === side && Math.abs(parseFloat(x.positionAmt)) > 0);
            
            if (p) {
                // Lấy Average Entry (VWAP) trực tiếp từ Binance sau khi khớp lệnh
                const avgEntry = parseFloat(p.entryPrice);
                
                const firstE = dcaData ? dcaData.firstEntry : avgEntry;
                const dcaCount = dcaData ? dcaData.dcaCount : 0;
                
                // Cập nhật Qty tổng sau khi nhồi
                const totalQty = Math.abs(parseFloat(p.positionAmt));

                let tp, sl;
                const dir = (side === 'LONG') ? 1 : -1;

                const targetProfit = (dcaCount + 1) * (totalQty * avgEntry * (botSettings.posTP / 100));
                tp = avgEntry + (dir * (targetProfit / totalQty));
                sl = firstE * (1 - (dir * (botSettings.posSL / 100)));

                const dcaThreshold = botSettings.posdca;
                const nextDCA = side === 'LONG' ? avgEntry * (1 + (dcaThreshold / 100)) : avgEntry * (1 - (dcaThreshold / 100));

                const sync = await syncTPSL(symbol, side, info, tp, sl);

                botActivePositions.set(lockKey, { 
                    symbol, side, entryPrice: firstE, tp: sync.tp, sl: sync.sl, dcaCount: dcaCount, 
                    leverage: info.maxLeverage, firstEntry: firstE, firstMargin: dcaData ? dcaData.firstMargin : actualMarginUsed, 
                    currentMargin: actualMarginUsed, currentQty: totalQty,
                    isDiangucMode: false, pnl: 0, profitPercent: 0, hitTime: null, avgEntry: avgEntry, nextDCA, livePrice: currentPrice
                });
                
                if (!isDCAorLong) {
                    const logStr = `[MỞ MỚI] ${symbol} | M: ${actualMarginUsed.toFixed(2)}$ | Lev: x${info.maxLeverage} | E: ${avgEntry.toFixed(4)} | TP: ${sync.tp.toFixed(4)} | SL: ${sync.sl.toFixed(4)} | Next DCA: ${nextDCA.toFixed(4)} | Avg: ${avgEntry.toFixed(4)}`;
                    addBotLog(logStr, "info");
                }
            }
        }
    } catch (e) { 
        status.permanentBlacklist[symbol] = true;
        addBotLog(`❌ [BAN VĨNH VIỄN] Lỗi tại ${symbol}: ${e.message}`, "error"); 
    } finally { 
        setTimeout(() => isProcessingDCA.delete(lockKey), 3000); 
    }
}

async function syncTPSL(symbol, side, info, tpPrice, slPrice) {
    const sideClose = side === 'SHORT' ? 'BUY' : 'SELL';
    try {
        const orders = await binancePrivate('/fapi/v1/openOrders', 'GET', { symbol });
        for (const o of orders.filter(o => o.positionSide === side)) await binancePrivate('/fapi/v1/order', 'DELETE', { symbol, orderId: o.orderId });
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: tpPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        await exchange.createOrder(symbol, 'STOP_MARKET', sideClose, undefined, undefined, { positionSide: side, stopPrice: slPrice.toFixed(info.pricePrecision), closePosition: true, workingType: 'MARK_PRICE' });
        return { tp: tpPrice, sl: slPrice };
    } catch (e) { return { tp: 0, sl: 0 }; }
}

const APP = express(); APP.use(express.json()); APP.use(express.static(__dirname));

APP.get('/api/status', async (req, res) => {
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    
    // XỬ LÝ BLACKLIST ĐẾM NGƯỢC
    const now = Date.now();
    const formattedBlacklist = {};
    for (const [sym, expireTime] of Object.entries(status.blackList)) {
        const remainingSecs = Math.floor((expireTime - now) / 1000);
        if (remainingSecs > 0) {
            formattedBlacklist[sym] = remainingSecs;
        }
    }

    const responseStatus = {
        ...status,
        blackList: formattedBlacklist
    };

    res.json({ 
        botSettings, 
        activePositions: Array.from(botActivePositions.values()), 
        status: responseStatus, 
        wallet: acc ? { 
            totalWalletBalance: parseFloat(acc.totalMarginBalance || 0).toFixed(2), 
            availableBalance: parseFloat(acc.availableBalance || 0).toFixed(2), 
            totalUnrealizedProfit: parseFloat(acc.totalUnrealizedProfit || 0).toFixed(2) 
        } : { totalWalletBalance: "0", availableBalance: "0", totalUnrealizedProfit: "0" } 
    });
});

APP.post('/api/settings', (req, res) => { 
    botSettings = { ...botSettings, ...req.body }; 
    res.json({ success: true }); 
});

APP.post('/api/close_position', async (req, res) => {
    const { symbol, side } = req.body;
    const key = `${symbol}_${side}`;
    const b = botActivePositions.get(key);
    if (!b) return res.json({ success: false, msg: "Không tìm thấy lệnh" });
    try {
        await closePositionAndLog(b, b.livePrice, "ĐÓNG THỦ CÔNG");
        botActivePositions.delete(key);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

APP.post('/api/close_all', async (req, res) => {
    try {
        let count = 0;
        for (let [key, b] of botActivePositions) {
            await closePositionAndLog(b, b.livePrice, "PANIC CLOSE");
            botActivePositions.delete(key);
            count++;
        }
        res.json({ success: true, count });
    } catch (e) { res.json({ success: false, msg: e.message }); }
});

async function init() {
    try {
        await exchange.loadMarkets();
        const info = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brk = await binancePrivate('/fapi/v1/leverageBracket');
        const temp = {};
        info.data.symbols.forEach(s => {
            if (s.status !== 'TRADING') return; 
            const b = brk.find(x => x.symbol === s.symbol);
            const maxLev = b?.brackets[0]?.initialLeverage || 20;
            if (maxLev < 20) { status.permanentBlacklist[s.symbol] = true; return; }
            temp[s.symbol] = { quantityPrecision: s.quantityPrecision, pricePrecision: s.pricePrecision, stepSize: parseFloat(s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize), maxLeverage: maxLev };
        });
        status.exchangeInfo = temp; 
        initBot(); 
    } catch (e) { setTimeout(init, 5000); }
}

init();

setInterval(() => {
    http.get('http://127.0.0.1:9000/api/data', res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { status.candidatesList = JSON.parse(d).live || []; } catch(e){} });
    }).on('error', () => {});
}, 1500);

setInterval(async () => {
    if (!status.isReady || !botSettings.isRunning) return;
    const acc = await binancePrivate('/fapi/v2/account').catch(() => null);
    if (acc) {
        const totalWallet = parseFloat(acc.totalMarginBalance || 0);
        const availUsdt = parseFloat(acc.availableBalance || 0);
        if (totalWallet > 0) {
            const availPercent = (availUsdt / totalWallet) * 100;
            if (!isMarginProtected && availPercent < MARGIN_PROTECT_LIMIT) isMarginProtected = true;
            else if (isMarginProtected && availPercent >= MARGIN_RECOVER_LIMIT) isMarginProtected = false;
        }
    }
    if (isMarginProtected) return;

    if (botActivePositions.size < botSettings.maxPositions && isProcessingDCA.size === 0) {
        const entryData = status.candidatesList.find(c => checkEntryCondition(c, botSettings, status, botActivePositions));
        if (entryData) openPosition(entryData.symbol, null, entryData.side);
    }
}, 3000); 

APP.listen(6789);
